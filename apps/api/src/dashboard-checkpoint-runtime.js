import { createHmac, randomUUID } from 'node:crypto';
import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import { authorize } from '@crm-silmer/identity-access';
import { fingerprintCommand } from '@crm-silmer/integration-reliability';
import { decryptJson, encryptJson } from '@crm-silmer/n8n-integration';
import { operationalDay } from '@crm-silmer/orders';
import { readDashboardPerformance } from './dashboard-runtime.js';

const ZONE = 'America/Sao_Paulo';
const SCHEMA = 'daily-sales-v1';
const UNKNOWN_AFTER_MS = 5 * 60_000;
const RESULT_CODES = new Set([
  'PROVIDER_ACCEPTED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'RECIPIENT_UNREGISTERED',
  'RECIPIENT_LOOKUP_UNAVAILABLE',
]);

export class CheckpointError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'CheckpointError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** @param {unknown} value */
function id(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new CheckpointError(400, 'INVALID_REQUEST');
  return value;
}

/** @param {unknown} value */
function uuid(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      value,
    )
  )
    throw new CheckpointError(400, 'INVALID_REQUEST');
  return value;
}

/** @param {string} day @param {number} days */
function shift(day, days) {
  return new Date(Date.parse(day + 'T00:00:00Z') + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Civil dates, not a rolling 24-hour window. @param {Date} now */
export function checkpointDay(now) {
  return shift(operationalDay(now), -1);
}

/** Recovery is bounded to seven civil days; no future/current-day sends.
 * @param {unknown} value @param {Date} now */
function reportDay(value, now) {
  const day = value ?? checkpointDay(now);
  if (
    typeof day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
    !Number.isFinite(Date.parse(day + 'T00:00:00Z')) ||
    new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day ||
    day > checkpointDay(now) ||
    day < shift(operationalDay(now), -7)
  )
    throw new CheckpointError(422, 'INVALID_CHECKPOINT_DAY');
  return day;
}

/** Values must be private configuration, never source literals.
 * @param {Record<string,string|undefined>} environment */
export function checkpointConfiguration(environment) {
  const flag = environment.DAILY_CHECKPOINT_ENABLED;
  if (flag !== undefined && flag !== '' && flag !== 'true' && flag !== 'false')
    throw new Error('DAILY_CHECKPOINT_ENABLED must be true or false');
  let recipients = [];
  try {
    recipients = JSON.parse(
      environment.DAILY_CHECKPOINT_RECIPIENTS_JSON || '[]',
    );
  } catch {
    throw new Error(
      'DAILY_CHECKPOINT_RECIPIENTS_JSON must contain a private recipient list',
    );
  }
  if (
    !Array.isArray(recipients) ||
    ![0, 2].includes(recipients.length) ||
    recipients.some(
      (r) =>
        !r ||
        typeof r !== 'object' ||
        Object.keys(r).some((k) => !['id', 'label', 'phone'].includes(k)) ||
        typeof r.id !== 'string' ||
        !/^[a-z0-9_-]{1,48}$/u.test(r.id) ||
        typeof r.label !== 'string' ||
        !r.label.trim() ||
        r.label.length > 120 ||
        /[\u0000-\u001f\u007f]/u.test(r.label) ||
        typeof r.phone !== 'string' ||
        !/^\+[1-9]\d{7,14}$/u.test(r.phone),
    ) ||
    new Set(recipients.map((r) => r.id)).size !== recipients.length ||
    new Set(recipients.map((r) => r.phone)).size !== recipients.length
  )
    throw new Error(
      'DAILY_CHECKPOINT_RECIPIENTS_JSON must contain exactly two distinct valid private recipients',
    );
  const enabled = flag === 'true';
  const raw = environment.IDEMPOTENCY_ENVELOPE_KEY;
  const envelopeKey = raw ? Buffer.from(raw, 'base64') : null;
  if (envelopeKey && envelopeKey.length !== 32)
    throw new Error('IDEMPOTENCY_ENVELOPE_KEY must decode to 32 bytes');
  if (enabled && (!envelopeKey || recipients.length !== 2))
    throw new Error(
      'Daily checkpoint requires its encryption key and two private recipients',
    );
  return {
    enabled,
    configured: recipients.length === 2,
    recipients,
    envelopeKey,
  };
}

/** @param {any} report @param {string} day */
export function formatDailyCheckpoint(report, day) {
  const money = (/** @type {unknown} */ cents) =>
    new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(Number(cents ?? 0) / 100);
  const total = report.totals ?? {};
  const lines = [
    `Resumo comercial — ${day.split('-').reverse().join('/')}`,
    '',
    `Vendido: ${money(total.soldAmountCents)} · ${Number(total.confirmedCount ?? 0)} pedidos`,
    `Ticket médio: ${money(total.confirmedCount ? Math.round(total.soldAmountCents / total.confirmedCount) : 0)}`,
    '',
  ];
  for (const row of report.rows ?? [])
    lines.push(
      `${String(row.name)
        .replace(/[\r\n\t]/gu, ' ')
        .trim()}: ${money(row.soldAmountCents)} · ${Number(row.confirmedCount ?? 0)} pedidos`,
    );
  lines.push(
    `Loja do site: ${money(report.store?.soldAmountCents)} · ${Number(report.store?.confirmedCount ?? 0)} pedidos`,
    `Sem atribuição: ${money(report.unattributed?.soldAmountCents)} · ${Number(report.unattributed?.confirmedCount ?? 0)} pedidos`,
    '',
    'Pedidos confirmados; recebimentos não incluídos.',
  );
  if (Number(report.unattributed?.confirmedCount ?? 0) > 0)
    lines.push(
      'Histórico sem evidência de responsável permanece sem atribuição.',
    );
  const text = lines.join('\n');
  if (text.length > 3500)
    throw new CheckpointError(422, 'CHECKPOINT_REPORT_TOO_LARGE');
  return text;
}

/** @param {any} technical */
function requireTechnical(technical) {
  if (
    technical?.actor?.id !== 'AUTOMATION_EXECUTOR' ||
    technical?.actor?.kind !== 'AUTOMATION_EXECUTOR'
  )
    throw new CheckpointError(403, 'FORBIDDEN');
}

/** @param {any} client @param {any} actor */
async function requireManager(client, actor) {
  if (actor?.kind !== 'human' || !actor.id)
    throw new CheckpointError(403, 'FORBIDDEN');
  const { rows } = await client.query(
    `SELECT u.id,f.function_name FROM crm.users u JOIN crm.user_functions f ON f.user_id=u.id WHERE u.id=$1 AND u.disabled_at IS NULL FOR SHARE OF u,f`,
    [actor.id],
  );
  if (!rows[0]) throw new CheckpointError(403, 'FORBIDDEN');
  const grants = await client.query(
    'SELECT capability FROM crm.user_capabilities WHERE user_id=$1 FOR SHARE',
    [actor.id],
  );
  authorize(
    {
      id: actor.id,
      kind: 'human',
      functionName: rows[0].function_name,
      capabilities: grants.rows.map((/** @type {any} */ r) => r.capability),
    },
    'assistant.performance.read',
  );
}

/** @param {any} client @param {string} action @param {string} checkpointId @param {number} version @param {string} correlationId */
async function audit(client, action, checkpointId, version, correlationId) {
  await new PostgresAuditTrail(client).append({
    actor: 'AUTOMATION_EXECUTOR',
    action,
    target: { type: 'dashboard-checkpoint', id: checkpointId },
    version,
    reason: action,
    correlationId,
  });
}

/** @param {any} database @param {{access:any,environment?:Record<string,string|undefined>,clock?:()=>Date,readPerformance?:typeof readDashboardPerformance,idFactory?:()=>string}} options */
export function createDashboardCheckpointRuntime(database, options) {
  const config = checkpointConfiguration(options.environment ?? process.env);
  const clock = options.clock ?? (() => new Date());
  const factory = options.idFactory ?? randomUUID;
  const readPerformance = options.readPerformance ?? readDashboardPerformance;
  const aad = (/** @type {string} */ value) => `dashboard-checkpoint:${value}`;
  const digest = (/** @type {string} */ value) => {
    if (!config.envelopeKey)
      throw new CheckpointError(503, 'CHECKPOINT_NOT_CONFIGURED');
    return createHmac('sha256', config.envelopeKey)
      .update('checkpoint-recipient:' + value)
      .digest('hex');
  };
  const decode = (/** @type {any} */ row) => {
    if (!config.envelopeKey)
      throw new CheckpointError(503, 'CHECKPOINT_NOT_CONFIGURED');
    return decryptJson(row.content_envelope, aad(row.id), config.envelopeKey);
  };
  function requireEnabled() {
    if (!config.enabled) throw new CheckpointError(409, 'CHECKPOINT_DISABLED');
  }
  /** Snapshot conflicts have no external effect and can be retried safely.
   * @template T @param {(client:any)=>Promise<T>} work */
  async function snapshotTransaction(work) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await database.transaction(async (/** @type {any} */ client) => {
          await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          return work(client);
        });
      } catch (error) {
        const failure = /** @type {any} */ (error);
        const retryable =
          ['40001', '40P01'].includes(failure.code) ||
          (failure.code === '23505' &&
            failure.constraint ===
              'dashboard_checkpoint_snapshots_report_day_key');
        if (attempt >= 2 || !retryable) throw error;
      }
    }
  }
  return Object.freeze({
    /** @param {any} input */
    authorizeRead: (input) => options.access.authorizeRead(input),
    /** @param {{actor:any,day?:unknown}} input */
    async preview(input) {
      const now = clock(),
        day = reportDay(input.day, now);
      return database.transaction(async (/** @type {any} */ client) => {
        await requireManager(client, input.actor);
        const { rows } = await client.query(
          'SELECT * FROM crm.dashboard_checkpoint_snapshots WHERE report_day=$1',
          [day],
        );
        const stored = rows[0];
        const content = stored ? decode(stored) : null;
        const report =
          content?.report ??
          (await readPerformance(client, {
            from: day,
            to: day,
            manager: true,
          }));
        const deliveries = stored
          ? (
              await client.query(
                'SELECT recipient_id,status,reserved_at,completed_at FROM crm.dashboard_checkpoint_deliveries WHERE checkpoint_id=$1 ORDER BY recipient_id',
                [stored.id],
              )
            ).rows
          : [];
        const recipients = (content?.recipients ?? config.recipients).map(
          (/** @type {any} */ recipient) => {
            const row = deliveries.find(
              (/** @type {any} */ d) => d.recipient_id === recipient.id,
            );
            const stale =
              row?.status === 'reserved' &&
              now.getTime() - new Date(row.reserved_at).getTime() >=
                UNKNOWN_AFTER_MS;
            return {
              id: recipient.id,
              label: recipient.label,
              status: row
                ? stale
                  ? 'outcome_unknown'
                  : row.status
                : 'not_generated',
              updatedAt: row?.completed_at
                ? new Date(row.completed_at).toISOString()
                : row?.reserved_at
                  ? new Date(row.reserved_at).toISOString()
                  : null,
            };
          },
        );
        return {
          day,
          timezone: ZONE,
          scheduledAt: '08:00',
          enabled: config.enabled,
          configured: config.configured,
          snapshot: Boolean(stored),
          generatedAt: stored
            ? new Date(stored.generated_at).toISOString()
            : now.toISOString(),
          previewText: content?.text ?? formatDailyCheckpoint(report, day),
          recipients,
          totals: report.totals,
        };
      });
    },
    /** @param {{technical:any,day?:unknown,correlationId:string}} input */
    async prepare(input) {
      requireTechnical(input.technical);
      requireEnabled();
      const now = clock(),
        day = reportDay(input.day, now);
      return snapshotTransaction(async (/** @type {any} */ client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          ['daily-checkpoint:' + day],
        );
        let row = (
          await client.query(
            'SELECT * FROM crm.dashboard_checkpoint_snapshots WHERE report_day=$1',
            [day],
          )
        ).rows[0];
        if (!row) {
          const checkpointId = factory();
          const report = await readPerformance(client, {
            from: day,
            to: day,
            manager: true,
          });
          const recipients = config.recipients.map((r) => ({
            id: r.id,
            label: r.label,
            fingerprint: digest(r.phone),
          }));
          const content = {
            report,
            recipients,
            text: formatDailyCheckpoint(report, day),
          };
          const envelope = encryptJson(
            content,
            aad(checkpointId),
            /** @type {Buffer} */ (config.envelopeKey),
          );
          row = (
            await client.query(
              `INSERT INTO crm.dashboard_checkpoint_snapshots (id,report_day,schema_version,generated_at,content_envelope,report_hash,sold_amount_cents,confirmed_count) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING *`,
              [
                checkpointId,
                day,
                SCHEMA,
                now.toISOString(),
                JSON.stringify(envelope),
                fingerprintCommand(content),
                report.totals.soldAmountCents,
                report.totals.confirmedCount,
              ],
            )
          ).rows[0];
          for (const recipient of recipients)
            await client.query(
              `INSERT INTO crm.dashboard_checkpoint_deliveries (checkpoint_id,recipient_id,recipient_fingerprint) VALUES ($1,$2,$3)`,
              [checkpointId, recipient.id, recipient.fingerprint],
            );
          await audit(
            client,
            'dashboard.checkpoint.prepared',
            checkpointId,
            1,
            input.correlationId,
          );
        }
        const content = decode(row);
        return {
          checkpointId: row.id,
          day,
          generatedAt: new Date(row.generated_at).toISOString(),
          recipients: content.recipients.map((/** @type {any} */ r) => ({
            id: r.id,
            label: r.label,
          })),
        };
      });
    },
    /** Natural idempotency never reissues a transport permission, even on replay.
     * @param {{technical:any,checkpointId:string,recipientId:string,correlationId:string}} input */
    async reserve(input) {
      requireTechnical(input.technical);
      requireEnabled();
      const checkpointId = uuid(input.checkpointId),
        recipientId = id(input.recipientId),
        now = clock();
      return database.transaction(async (/** @type {any} */ client) => {
        const row = (
          await client.query(
            'SELECT *,report_day::text AS report_day FROM crm.dashboard_checkpoint_snapshots WHERE id=$1',
            [checkpointId],
          )
        ).rows[0];
        if (!row) throw new CheckpointError(404, 'CHECKPOINT_NOT_FOUND');
        reportDay(String(row.report_day).slice(0, 10), now);
        const recipient = config.recipients.find((r) => r.id === recipientId);
        const delivery = (
          await client.query(
            'SELECT * FROM crm.dashboard_checkpoint_deliveries WHERE checkpoint_id=$1 AND recipient_id=$2 FOR UPDATE',
            [checkpointId, recipientId],
          )
        ).rows[0];
        if (!recipient || !delivery)
          throw new CheckpointError(404, 'CHECKPOINT_NOT_FOUND');
        if (delivery.recipient_fingerprint !== digest(recipient.phone))
          throw new CheckpointError(409, 'CHECKPOINT_RECIPIENT_CHANGED');
        if (delivery.status !== 'pending')
          return {
            authorized: false,
            checkpointId,
            recipientId,
            status: delivery.status,
          };
        const reservationId = factory();
        await client.query(
          `UPDATE crm.dashboard_checkpoint_deliveries SET status='reserved',reservation_id=$3,reserved_at=$4,version=version+1 WHERE checkpoint_id=$1 AND recipient_id=$2`,
          [checkpointId, recipientId, reservationId, now.toISOString()],
        );
        await audit(
          client,
          'dashboard.checkpoint.reserved',
          checkpointId,
          Number(delivery.version) + 1,
          input.correlationId,
        );
        return {
          authorized: true,
          checkpointId,
          recipientId,
          reservationId,
          phone: recipient.phone,
          text: decode(row).text,
        };
      });
    },
    /** @param {{technical:any,checkpointId:string,recipientId:string,reservationId:string,status:string,code:string,providerMessageId?:unknown,reconciled?:boolean,correlationId:string}} input */
    async complete(input) {
      requireTechnical(input.technical);
      const checkpointId = uuid(input.checkpointId),
        recipientId = id(input.recipientId),
        reservationId = uuid(input.reservationId);
      if (
        !['sent', 'failed', 'outcome_unknown'].includes(input.status) ||
        !RESULT_CODES.has(input.code) ||
        (input.status === 'sent' &&
          (input.code !== 'PROVIDER_ACCEPTED' ||
            typeof input.providerMessageId !== 'string')) ||
        (input.status === 'failed' &&
          !['RECIPIENT_UNREGISTERED', 'RECIPIENT_LOOKUP_UNAVAILABLE'].includes(
            input.code,
          )) ||
        (input.status === 'outcome_unknown' &&
          input.code !== 'PROVIDER_OUTCOME_UNKNOWN') ||
        (input.status !== 'sent' && input.providerMessageId !== undefined) ||
        (input.reconciled !== undefined &&
          typeof input.reconciled !== 'boolean')
      )
        throw new CheckpointError(400, 'INVALID_REQUEST');
      const providerId =
        input.status === 'sent' ? id(input.providerMessageId) : null;
      return database.transaction(async (/** @type {any} */ client) => {
        const row = (
          await client.query(
            'SELECT * FROM crm.dashboard_checkpoint_deliveries WHERE checkpoint_id=$1 AND recipient_id=$2 FOR UPDATE',
            [checkpointId, recipientId],
          )
        ).rows[0];
        if (!row || row.reservation_id !== reservationId)
          throw new CheckpointError(404, 'CHECKPOINT_NOT_FOUND');
        if (
          row.status === input.status &&
          row.result_code === input.code &&
          row.provider_message_id === providerId
        )
          return { recorded: false, status: row.status };
        if (
          row.status !== 'reserved' &&
          !(
            row.status === 'outcome_unknown' &&
            input.status === 'sent' &&
            input.reconciled === true
          )
        )
          throw new CheckpointError(409, 'CHECKPOINT_RESULT_CONFLICT');
        await client.query(
          `UPDATE crm.dashboard_checkpoint_deliveries SET status=$3,result_code=$4,provider_message_id=$5,completed_at=$6,version=version+1 WHERE checkpoint_id=$1 AND recipient_id=$2`,
          [
            checkpointId,
            recipientId,
            input.status,
            input.code,
            providerId,
            clock().toISOString(),
          ],
        );
        await audit(
          client,
          'dashboard.checkpoint.' + input.status,
          checkpointId,
          Number(row.version) + 1,
          input.correlationId,
        );
        return { recorded: true, status: input.status };
      });
    },
  });
}
