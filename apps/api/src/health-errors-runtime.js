import { createHash, randomUUID } from 'node:crypto';

import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import {
  fingerprintCommand,
  PostgresIdempotencyRecordStore,
} from '@crm-silmer/integration-reliability';

const STATUSES = new Set(['new', 'investigating', 'resolved']);
const CODES = new Map([
  ['API_5XX', 'api'],
  ['API_NOT_READY', 'api'],
  ['WORKER_RETRY', 'worker'],
  ['WORKER_DEAD_LETTER', 'worker'],
  ['WORKER_OUTCOME_UNKNOWN', 'worker'],
  ['N8N_FAILED', 'n8n'],
  ['N8N_OUTCOME_UNKNOWN', 'n8n'],
  ['N8N_PROCESSING_EXPIRED', 'n8n'],
]);
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const RETENTION_SQL = [
  `DELETE FROM crm.operational_incident_receipts WHERE event_key IN (
     SELECT event_key FROM crm.operational_incident_receipts
     WHERE observed_at < now() - interval '14 days'
     ORDER BY observed_at, event_key LIMIT 1000
   ) RETURNING event_key`,
  `DELETE FROM crm.operational_incident_history WHERE id IN (
     SELECT id FROM crm.operational_incident_history
      WHERE occurred_at < now() - interval '14 days'
        OR EXISTS (SELECT 1 FROM crm.operational_incidents i
          WHERE i.id=incident_id AND i.last_seen_at < now() - interval '14 days'
            AND NOT EXISTS (SELECT 1 FROM crm.operational_incident_receipts r
              WHERE r.incident_id=i.id AND r.observed_at >= now()-interval '14 days'))
     ORDER BY occurred_at, id LIMIT 1000
   ) RETURNING id`,
  // Never cascade a large group: its children must drain in bounded batches first.
  `DELETE FROM crm.operational_incidents WHERE id IN (
     SELECT i.id FROM crm.operational_incidents i
     WHERE i.last_seen_at < now() - interval '14 days'
       AND NOT EXISTS (SELECT 1 FROM crm.operational_incident_receipts r WHERE r.incident_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM crm.operational_incident_history h WHERE h.incident_id = i.id)
     ORDER BY i.last_seen_at, i.id LIMIT 1000
   ) RETURNING id`,
];

/** @param {number} statusCode @param {string} code */
function failure(statusCode, code) {
  return Object.assign(new Error(code), { code, statusCode });
}

/** @param {unknown} input */
export function validateIncidentChange(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw failure(400, 'INVALID_REQUEST');
  const body = /** @type {Record<string, any>} */ (input);
  if (
    Object.keys(body).some((key) => !['status', 'version'].includes(key)) ||
    !STATUSES.has(body.status) ||
    !Number.isSafeInteger(body.version) ||
    body.version < 1
  )
    throw failure(400, 'INVALID_REQUEST');
  return {
    status: /** @type {string} */ (body.status),
    version: /** @type {number} */ (body.version),
  };
}

/** @param {unknown} input */
export function validateLegacyArchive(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw failure(400, 'INVALID_REQUEST');
  const body = /** @type {Record<string, any>} */ (input);
  if (
    Object.keys(body).some((key) => !['count', 'fingerprint'].includes(key)) ||
    !Number.isSafeInteger(body.count) ||
    body.count < 1 ||
    body.count > 100 ||
    typeof body.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(body.fingerprint)
  )
    throw failure(400, 'INVALID_REQUEST');
  return {
    count: /** @type {number} */ (body.count),
    fingerprint: body.fingerprint,
  };
}

/** @param {any} row */
function incidentView(row) {
  if (
    !CODES.has(row.code) ||
    CODES.get(row.code) !== row.source ||
    !STATUSES.has(row.status)
  )
    throw failure(503, 'SERVICE_UNAVAILABLE');
  return {
    id: String(row.id),
    source: String(row.source),
    code: String(row.code),
    status: String(row.status),
    occurrences: Number(row.occurrences),
    activeCount: Number(row.active_count ?? 0),
    activeFirstSeenAt: row.active_first_seen_at
      ? new Date(row.active_first_seen_at).toISOString()
      : null,
    activeLastSeenAt: row.active_last_seen_at
      ? new Date(row.active_last_seen_at).toISOString()
      : null,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    version: Number(row.version),
    ...(UUID.test(String(row.request_id)) ? { requestId: row.request_id } : {}),
    ...(UUID.test(String(row.correlation_id))
      ? { correlationId: row.correlation_id }
      : {}),
    history: (Array.isArray(row.history) ? row.history : []).map(
      (/** @type {any} */ event) => ({
        status: STATUSES.has(event.status) ? event.status : 'new',
        at: new Date(event.at).toISOString(),
      }),
    ),
  };
}

/** @param {any} client */
async function cleanup(client) {
  await client.query("SET LOCAL lock_timeout = '100ms'");
  await client.query("SET LOCAL statement_timeout = '1s'");
  const lock = await client.query(
    "SELECT pg_try_advisory_xact_lock(hashtextextended('operational-incidents', 0)) AS acquired",
  );
  if (lock.rows[0]?.acquired !== true)
    return { skipped: true, deleted: 0, batchFull: false };
  let deleted = 0;
  let batchFull = false;
  for (const sql of RETENTION_SQL) {
    const result = await client.query(sql);
    deleted += result.rows.length;
    batchFull ||= result.rows.length === 1000;
  }
  return { skipped: false, deleted, batchFull };
}

/**
 * One receipt per technical effect revision prevents refresh from counting the
 * same failure twice. The advisory lock serializes intake with human triage.
 * @param {any} client
 * @param {{source: string, code: string, eventKey: string, at: Date, requestId?: string, correlationId?: string}} input
 */
async function recordIncident(client, input) {
  if (
    CODES.get(input.code) !== input.source ||
    !/^[a-f0-9]{64}$/u.test(input.eventKey)
  )
    throw new TypeError('Unsupported technical incident');
  const id = `incident-${createHash('sha256').update(`${input.source}:${input.code}`).digest('hex').slice(0, 32)}`;
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('operational-incidents', 0))",
  );
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    id,
  ]);
  const trace = (/** @type {unknown} */ value) =>
    typeof value === 'string' && UUID.test(value) ? value : null;
  const created = await client.query(
    `INSERT INTO crm.operational_incidents
      (id, source, code, first_seen_at, last_seen_at, updated_at, request_id, correlation_id)
     VALUES ($1, $2, $3, $4, $4, now(), $5, $6)
     ON CONFLICT (source, code) DO NOTHING RETURNING *`,
    [
      id,
      input.source,
      input.code,
      input.at,
      trace(input.requestId),
      trace(input.correlationId),
    ],
  );
  const receipt = await client.query(
    `INSERT INTO crm.operational_incident_receipts (event_key, incident_id, observed_at)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_key`,
    [input.eventKey, id, input.at],
  );
  if (receipt.rows.length === 0) return;
  let row = created.rows[0];
  if (!row) {
    const previous = await client.query(
      'SELECT status FROM crm.operational_incidents WHERE id = $1 FOR UPDATE',
      [id],
    );
    const updated = await client.query(
      `UPDATE crm.operational_incidents SET
        occurrences = occurrences + 1,
        first_seen_at = least(first_seen_at, $2),
        last_seen_at = greatest(last_seen_at, $2),
        status = CASE WHEN status = 'resolved' AND $2 >= updated_at THEN 'new' ELSE status END,
        updated_at = CASE WHEN status = 'resolved' AND $2 < updated_at THEN updated_at ELSE now() END,
        version = nextval('crm.operational_incident_version'),
        request_id = $3, correlation_id = $4
       WHERE id = $1 RETURNING *`,
      [id, input.at, trace(input.requestId), trace(input.correlationId)],
    );
    row = updated.rows[0];
    if (row.status === previous.rows[0].status) return;
  }
  await client.query(
    `INSERT INTO crm.operational_incident_history (id, incident_id, status, occurred_at, version)
     VALUES ($1, $2, $3, now(), $4)`,
    [randomUUID(), id, row.status, row.version],
  );
}

const SOURCE_STATES_SQL = `
    SELECT 'worker' AS source,
      CASE status WHEN 'retry' THEN 'WORKER_RETRY'
        WHEN 'dead_letter' THEN 'WORKER_DEAD_LETTER'
        ELSE 'WORKER_OUTCOME_UNKNOWN' END AS code,
      updated_at AS observed_at,
      'worker:' || id || ':' || status || ':' || attempt_count::text AS receipt,
      n8n_command_id
    FROM crm.outbox_jobs
    WHERE status IN ('retry', 'dead_letter', 'outcome_unknown')
      AND updated_at >= now() - interval '14 days'
    UNION ALL
    SELECT 'n8n',
      CASE status WHEN 'failed' THEN 'N8N_FAILED'
        WHEN 'outcome_unknown' THEN 'N8N_OUTCOME_UNKNOWN'
        ELSE 'N8N_PROCESSING_EXPIRED' END,
      CASE WHEN status = 'processing' THEN locked_until ELSE updated_at END,
      'n8n:' || command_id || ':' || status || ':' ||
        extract(epoch FROM CASE WHEN status = 'processing' THEN locked_until ELSE updated_at END)::text,
      command_id
    FROM crm.n8n_commands
    WHERE (status IN ('failed', 'outcome_unknown')
        OR (status = 'processing' AND locked_until < now()))
      AND updated_at >= now() - interval '14 days'`;

const SOURCE_FAILURES_SQL = `
  WITH sources AS (${SOURCE_STATES_SQL}), candidates AS (
    SELECT source, code, observed_at,
      encode(sha256(convert_to(receipt, 'UTF8')), 'hex') AS event_key
    FROM sources
    WHERE observed_at <= now() AND observed_at >= now() - interval '14 days'
  )
  SELECT * FROM candidates c WHERE NOT EXISTS (
    SELECT 1 FROM crm.operational_incident_receipts r WHERE r.event_key = c.event_key
  ) ORDER BY observed_at ASC, event_key ASC LIMIT 501`;

// OPS-INBOX-SEND-08: a concluded failure remains in intake/history. Only its
// active projection can omit it, with immutable evidence and a closed queue
// reconciliation. Triage alone and an uncertain transport never satisfy this.
const CONCLUDED_SENDS_SQL = `
  SELECT c.command_id
  FROM crm.n8n_commands c
  JOIN crm.messages m ON m.id=c.message_id AND m.command_id=c.command_id
    AND m.conversation_id=c.conversation_id
  JOIN crm.outbox_jobs j ON j.n8n_command_id=c.command_id
    AND j.message_id=m.id AND j.job_type='n8n.command.deliver'
  JOIN crm.reconciliation_items r ON r.job_id=j.id
  WHERE c.action='send_message' AND c.actor_kind='human'
    AND m.author_kind='human' AND m.author_id=c.actor_id
    AND c.status='failed' AND m.status='failed' AND m.delivery_status='failed'
    AND c.retryable=false AND c.retry_safe=false
    AND c.external_message_id IS NULL AND m.external_message_id IS NULL
    AND j.status='dead_letter'
    AND r.status='resolved' AND r.resolved_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM crm.n8n_events effect WHERE effect.message_id=m.id
        AND effect.event_type IN ('message.sent','message.delivered','message.read','message.send.unknown')
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm.message_delivery_attempts effect WHERE effect.message_id=m.id
        AND (effect.external_message_id IS NOT NULL
          OR effect.status IN ('pending','sent','delivered','read','outcome_unknown'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm.outbox_jobs other_job
      WHERE other_job.n8n_command_id=c.command_id
        AND (other_job.status<>'dead_letter' OR NOT EXISTS (
          SELECT 1 FROM crm.reconciliation_items closed
          WHERE closed.job_id=other_job.id AND closed.status='resolved'
            AND closed.resolved_at IS NOT NULL
        ))
    )
    AND (
      (c.last_error_code='N8N_COMMAND_RESERVATION_REJECTED'
        AND j.last_error_code=c.last_error_code
        AND m.n8n_execution_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM crm.n8n_events e WHERE e.message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM crm.message_delivery_attempts a WHERE a.message_id=m.id)
        AND EXISTS (
          SELECT 1 FROM crm.audit_events audit
          WHERE audit.action='integration.n8n.command.reconciled'
            AND audit.target_type='n8n_command' AND audit.target_id=c.command_id
            AND audit.version='OPS-INBOX-SEND-07'
            AND audit.reason='PROVEN_FAILURE_BEFORE_SEND_RESERVATION'
            AND audit.correlation_id ~ '^n8n-execution:[0-9]{1,12}$'
        ))
      OR
      (c.last_error_code='MEDIA_PREFLIGHT_UNAVAILABLE'
        AND m.message_type IN ('image','audio','video')
        AND j.last_error_code=c.last_error_code AND m.delivery_failure_code=c.last_error_code
        AND m.automation_epoch=c.automation_epoch
        AND EXISTS (
          SELECT 1 FROM crm.n8n_events reservation
          JOIN crm.audit_events audit ON audit.target_id=c.command_id
            AND audit.target_type='n8n_command'
            AND audit.action='integration.n8n.command.reconciled'
            AND audit.version='OPS-INBOX-SEND-09'
            AND audit.reason='PROVEN_MEDIA_FAILURE_BEFORE_TRANSPORT'
            AND audit.correlation_id='n8n-execution:' || reservation.execution_id
          JOIN crm.users operator ON operator.id=audit.actor_id
            AND operator.email='admin@crm-silmer.local'
          WHERE reservation.message_id=m.id AND reservation.conversation_id=c.conversation_id
            AND reservation.event_type='message.send.requested'
            AND reservation.execution_id=m.n8n_execution_id
            AND reservation.automation_epoch=c.automation_epoch
        ))
      OR
      (c.last_error_code IN ('EVOLUTION_RECIPIENT_NOT_FOUND','EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE',
          'MEDIA_DOWNLOAD_FAILED','MEDIA_INTEGRITY_MISMATCH','MEDIA_UPLOAD_FAILED',
          'MEDIA_PREFLIGHT_REJECTED','MEDIA_PREFLIGHT_UNAVAILABLE')
        AND (j.last_error_code=c.last_error_code OR j.last_error_code='N8N_COMMAND_REJECTED')
        AND m.delivery_failure_code=c.last_error_code
        AND m.automation_epoch=c.automation_epoch
        AND EXISTS (
          SELECT 1 FROM crm.n8n_events failure
          JOIN crm.n8n_events reservation ON reservation.message_id=failure.message_id
            AND reservation.conversation_id=failure.conversation_id
            AND reservation.event_type='message.send.requested'
            AND reservation.execution_id=failure.execution_id
            AND reservation.workflow_key=failure.workflow_key
            AND reservation.workflow_version=failure.workflow_version
            AND reservation.automation_epoch=failure.automation_epoch
            AND reservation.source_revision=failure.source_revision
          WHERE failure.message_id=m.id AND failure.conversation_id=c.conversation_id
            AND failure.event_type='workflow.failed'
            AND failure.execution_id=m.n8n_execution_id
            AND failure.automation_epoch=c.automation_epoch
            AND failure.outcome->>'failureCode'=c.last_error_code
            AND ((c.last_error_code IN ('EVOLUTION_RECIPIENT_NOT_FOUND','EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE')
                  AND NOT failure.outcome ? 'deliveryStatus')
                 OR failure.outcome->>'deliveryStatus'='failed')
        ))
    )`;

// An operator disposition can end actionable work without inventing the old
// transport result. Source state and history remain unknown. The private helper
// verifies the replacement's unchanged destination/content before this audit.
const OPERATIONALLY_CLOSED_SENDS_SQL = `
  SELECT c.command_id
  FROM crm.n8n_commands c
  JOIN crm.messages m ON m.id=c.message_id AND m.command_id=c.command_id
    AND m.conversation_id=c.conversation_id
  JOIN crm.conversations conversation ON conversation.id=c.conversation_id
  JOIN crm.audit_events audit ON audit.target_id=c.command_id
    AND audit.target_type='n8n_command'
    AND audit.action='integration.n8n.command.operationally_closed'
    AND audit.version='OPS-INBOX-SEND-08'
  JOIN crm.users operator ON operator.id=audit.actor_id
    AND operator.email='admin@crm-silmer.local'
  WHERE c.action='send_message' AND c.actor_kind='human'
    AND m.author_kind='human' AND m.author_id=c.actor_id AND m.message_type='text'
    AND c.status='outcome_unknown' AND m.status='outcome_unknown'
    AND m.delivery_status='outcome_unknown'
    AND c.retryable=false AND c.retry_safe=false
    AND c.external_message_id IS NULL AND m.external_message_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM crm.n8n_events positive WHERE positive.message_id=m.id
        AND positive.event_type IN ('message.sent','message.delivered','message.read')
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm.message_delivery_attempts positive WHERE positive.message_id=m.id
        AND (positive.external_message_id IS NOT NULL
          OR positive.status IN ('sent','delivered','read'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm.outbox_jobs job WHERE job.n8n_command_id=c.command_id
        AND (job.job_type<>'n8n.command.deliver' OR job.message_id IS DISTINCT FROM m.id
          OR job.status NOT IN ('outcome_unknown','dead_letter','completed'))
    )
    AND (
      (audit.reason='NON_PRODUCTION_CONVERSATION'
        AND conversation.provider_account_id IN ('dev-phone-number','synthetic-ux-longitudinal')
        AND m.provider_account_id=conversation.provider_account_id
        AND m.provider=conversation.provider)
      OR
      (audit.reason='SUPERSEDED_BY_VERIFIED_SENT_COMMAND' AND EXISTS (
        SELECT 1 FROM crm.n8n_commands replacement
        JOIN crm.messages sent ON sent.id=replacement.message_id
          AND sent.command_id=replacement.command_id
          AND sent.conversation_id=replacement.conversation_id
        WHERE audit.correlation_id='n8n-command:' || replacement.command_id
          AND replacement.command_id<>c.command_id
          AND replacement.conversation_id=c.conversation_id
          AND replacement.created_at>c.created_at
          AND replacement.action='send_message' AND replacement.actor_kind='human'
          AND sent.author_kind='human' AND sent.author_id=replacement.actor_id
          AND sent.message_type=m.message_type
          AND replacement.status='sent' AND sent.status='sent'
          AND sent.delivery_status IN ('sent','delivered','read')
          AND replacement.external_message_id IS NOT NULL
          AND length(replacement.external_message_id)>0
          AND replacement.external_message_id=sent.external_message_id
          AND EXISTS (SELECT 1 FROM crm.n8n_events receipt
            WHERE receipt.message_id=sent.id AND receipt.conversation_id=c.conversation_id
              AND receipt.event_type='message.sent')
      ))
    )`;

const ACTIVE_FAILURES_SQL = `WITH sources AS (${SOURCE_STATES_SQL}),
  concluded AS (${CONCLUDED_SENDS_SQL}),
  operationally_closed AS (${OPERATIONALLY_CLOSED_SENDS_SQL})
  SELECT source, code, count(*)::int AS active_count,
    min(observed_at) AS active_first_seen_at, max(observed_at) AS active_last_seen_at
  FROM sources s
  WHERE observed_at <= now() AND observed_at >= now() - interval '14 days'
    AND NOT EXISTS (SELECT 1 FROM crm.n8n_command_operational_archives a
                    WHERE a.command_id = s.n8n_command_id)
    AND NOT EXISTS (SELECT 1 FROM concluded c WHERE c.command_id=s.n8n_command_id)
    AND NOT EXISTS (SELECT 1 FROM operationally_closed c WHERE c.command_id=s.n8n_command_id)
  GROUP BY source, code`;

/** @param {any} client @param {any[]} rows */
async function projectActivity(client, rows) {
  const active = (await client.query(ACTIVE_FAILURES_SQL)).rows;
  return rows.map((row) => {
    const current = active.find(
      (/** @type {any} */ source) =>
        source.source === row.source && source.code === row.code,
    );
    const apiActive = row.source === 'api' && row.status !== 'resolved';
    return incidentView({
      ...row,
      active_count: apiActive ? row.occurrences : (current?.active_count ?? 0),
      active_first_seen_at: apiActive
        ? row.first_seen_at
        : current?.active_first_seen_at,
      active_last_seen_at: apiActive
        ? row.last_seen_at
        : current?.active_last_seen_at,
    });
  });
}

/** @param {any} client @param {boolean} [lock] */
async function legacyArchiveManifest(client, lock = false) {
  const rows = (
    await client.query(
      `SELECT c.command_id, extract(epoch FROM c.updated_at)::text AS revision FROM crm.n8n_commands c
     JOIN crm.messages m ON m.id=c.message_id AND m.command_id=c.command_id
       AND m.conversation_id=c.conversation_id
     WHERE c.status = 'outcome_unknown' AND c.action = 'send_message'
       AND NOT EXISTS (SELECT 1 FROM crm.n8n_command_operational_archives a WHERE a.command_id=c.command_id)
       AND EXISTS (
         SELECT 1 FROM crm.n8n_events e WHERE e.message_id=c.message_id
           AND e.conversation_id=c.conversation_id
           AND e.event_type='message.send.requested'
           AND e.workflow_version='waha-webjs-1'
       )
     ORDER BY c.command_id${lock ? ' FOR UPDATE OF c' : ''}`,
    )
  ).rows;
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        rows.map((/** @type {any} */ row) => [row.command_id, row.revision]),
      ),
    )
    .digest('hex');
  return { rows, count: rows.length, fingerprint };
}

const SELECT_INCIDENT_SQL = `SELECT i.*, r.total AS occurrences,
  r.first_seen AS first_seen_at, r.last_seen AS last_seen_at, coalesce((
  SELECT jsonb_agg(h.entry ORDER BY h.occurred_at, h.version)
  FROM (SELECT jsonb_build_object('status', status, 'at', occurred_at) AS entry,
          occurred_at, version
        FROM crm.operational_incident_history WHERE incident_id = i.id
          AND occurred_at >= now() - interval '14 days'
        ORDER BY version DESC LIMIT 50) h
), '[]'::jsonb) AS history FROM crm.operational_incidents i
JOIN LATERAL (
  SELECT count(*)::bigint AS total, min(observed_at) AS first_seen, max(observed_at) AS last_seen
  FROM crm.operational_incident_receipts WHERE incident_id = i.id
    AND observed_at >= now() - interval '14 days'
) r ON r.total > 0`;

/**
 * No raw exception, URL, customer identifier or external error text enters this
 * runtime. It consumes existing durable failure states, never their payloads.
 * @param {{database: any, identity: any, envelopeKey: Buffer, clock?: () => Date}} options
 */
export function createHealthErrorsRuntime({
  database,
  identity,
  envelopeKey,
  clock = () => new Date(),
}) {
  /** @param {any} input @param {boolean} write */
  function credentials(input, write) {
    if (input.authorization !== undefined) throw failure(403, 'FORBIDDEN');
    if (
      (input.origin !== undefined &&
        !identity.allowedOrigins.includes(input.origin)) ||
      (input.origin === undefined &&
        (write || !['same-origin', 'none'].includes(input.secFetchSite)))
    )
      throw failure(403, 'FORBIDDEN');
    const cookies = new Map();
    if (typeof input.cookie === 'string') {
      for (const part of input.cookie.split(';')) {
        const index = part.indexOf('=');
        if (index < 1) continue;
        const key = part.slice(0, index).trim();
        if (cookies.has(key)) throw failure(400, 'INVALID_REQUEST');
        cookies.set(key, part.slice(index + 1).trim());
      }
    }
    const sessionToken = cookies.get('crm_session');
    if (
      !sessionToken ||
      (write &&
        (!input.csrfToken || cookies.get('crm_csrf') !== input.csrfToken))
    )
      throw failure(403, 'FORBIDDEN');
    return {
      action: write ? 'health.errors.update' : 'health.errors.read',
      sessionToken,
      ...(write ? { csrfToken: input.csrfToken } : {}),
    };
  }

  return Object.freeze({
    async cleanup() {
      return database.transaction(cleanup);
    },
    /** @param {any} input */
    async list(input) {
      const auth = credentials(input, false);
      const status = input.status ?? 'all';
      const view = input.view ?? 'active';
      if (status !== 'all' && !STATUSES.has(status))
        throw failure(400, 'INVALID_REQUEST');
      if (!['active', 'history'].includes(view))
        throw failure(400, 'INVALID_REQUEST');
      return database.transaction(async (/** @type {any} */ client) => {
        await identity.authorizeHealthErrors(auth, client);
        const sources = await client.query(SOURCE_FAILURES_SQL);
        // Limit each refresh to a bounded transaction. The next refresh continues
        // the unseen receipts instead of losing the older part of the queue.
        for (const source of sources.rows.slice(0, 500)) {
          await recordIncident(client, {
            source: source.source,
            code: source.code,
            at: new Date(source.observed_at),
            eventKey: source.event_key,
          });
        }
        const result = await client.query(
          `${SELECT_INCIDENT_SQL} WHERE i.last_seen_at >= now() - interval '14 days'
           ORDER BY i.last_seen_at DESC, i.id LIMIT 100`,
        );
        const items = await projectActivity(client, result.rows);
        const summary = { new: 0, investigating: 0, resolved: 0 };
        const activeSummary = { new: 0, investigating: 0, resolved: 0 };
        for (const item of items) {
          const key = /** @type {'new'|'investigating'|'resolved'} */ (
            item.status
          );
          summary[key] += 1;
          if (item.activeCount > 0) activeSummary[key] += 1;
        }
        const manifest = await legacyArchiveManifest(client);
        return {
          items: items.filter(
            (item) =>
              (status === 'all' || item.status === status) &&
              (view === 'history' || item.activeCount > 0),
          ),
          summary,
          activeSummary,
          legacyArchive: {
            count: manifest.count,
            fingerprint: manifest.fingerprint,
          },
          checkedAt: clock().toISOString(),
          collectionPending: sources.rows.length > 500,
        };
      });
    },

    /** @param {any} input */
    async change(input) {
      const auth = credentials(input, true);
      const command = validateIncidentChange(input.body);
      if (
        typeof input.id !== 'string' ||
        !/^incident-[a-f0-9]{32}$/u.test(input.id) ||
        typeof input.idempotencyKey !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.idempotencyKey)
      )
        throw failure(400, 'INVALID_REQUEST');
      return database.transaction(async (/** @type {any} */ client) => {
        const access = await identity.authorizeHealthErrors(auth, client);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('operational-incidents', 0))",
        );
        // The guard runs before receipt lookup, including on replay, and remains
        // inside the same transaction as the idempotency record and audit append.
        const idempotency = new PostgresIdempotencyRecordStore({
          database: {
            query: client.query.bind(client),
            transaction: (work) => work(client),
          },
          envelopeKey,
        });
        const action = 'health.errors.update';
        const target = { id: input.id, type: 'operational-incident' };
        return idempotency.execute(
          {
            action,
            actor: access.actor.id,
            correlationId: input.correlationId,
            fingerprint: fingerprintCommand({
              action,
              command,
              target,
              version: command.version,
            }),
            key: input.idempotencyKey,
            scope: `${access.actor.id}:${action}`,
            target,
            version: command.version,
            reason: 'operational_incident_triage',
          },
          async (transaction) => {
            await transaction.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
              [input.id],
            );
            const existing = await transaction.query(
              'SELECT * FROM crm.operational_incidents WHERE id = $1 FOR UPDATE',
              [input.id],
            );
            if (!existing.rows[0]) throw failure(404, 'NOT_FOUND');
            if (Number(existing.rows[0].version) !== command.version)
              throw failure(409, 'VERSION_CONFLICT');
            if (existing.rows[0].status !== command.status) {
              const changed = await transaction.query(
                "UPDATE crm.operational_incidents SET status = $2, version = nextval('crm.operational_incident_version'), updated_at = now() WHERE id = $1 RETURNING version",
                [input.id, command.status],
              );
              const changedVersion = Number(changed.rows[0].version);
              await transaction.query(
                `INSERT INTO crm.operational_incident_history (id, incident_id, status, occurred_at, actor_id, version)
               VALUES ($1, $2, $3, now(), $4, $5)`,
                [
                  randomUUID(),
                  input.id,
                  command.status,
                  access.actor.id,
                  changedVersion,
                ],
              );
              await new PostgresAuditTrail(transaction).append({
                action,
                actor: access.actor.id,
                correlationId: input.correlationId,
                target,
                reason: `incident_${command.status}`,
                version: changedVersion,
              });
            }
            const result = await transaction.query(
              `${SELECT_INCIDENT_SQL} WHERE i.id = $1`,
              [input.id],
            );
            return (await projectActivity(transaction, result.rows))[0];
          },
        );
      });
    },

    /** @param {any} input */
    async archiveLegacy(input) {
      const auth = credentials(input, true);
      const command = validateLegacyArchive(input.body);
      if (
        typeof input.idempotencyKey !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.idempotencyKey)
      )
        throw failure(400, 'INVALID_REQUEST');
      return database.transaction(async (/** @type {any} */ client) => {
        await client.query("SET LOCAL lock_timeout = '1500ms'");
        await client.query("SET LOCAL statement_timeout = '10s'");
        const access = await identity.authorizeHealthErrors(auth, client);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('operational-incidents', 0))",
        );
        const idempotency = new PostgresIdempotencyRecordStore({
          database: {
            query: client.query.bind(client),
            transaction: (work) => work(client),
          },
          envelopeKey,
        });
        const action = 'health.errors.legacy_archive';
        const target = { id: command.fingerprint, type: 'n8n-legacy-archive' };
        return idempotency.execute(
          {
            action,
            actor: access.actor.id,
            correlationId: input.correlationId,
            fingerprint: fingerprintCommand({
              action,
              command,
              target,
              version: command.count,
            }),
            key: input.idempotencyKey,
            scope: `${access.actor.id}:${action}`,
            target,
            version: command.count,
            reason: 'legacy_transport_retired_outcome_unknown',
          },
          async (transaction) => {
            const manifest = await legacyArchiveManifest(transaction, true);
            if (
              manifest.count !== command.count ||
              manifest.fingerprint !== command.fingerprint
            )
              throw failure(409, 'VERSION_CONFLICT');
            const archivedAt = clock().toISOString();
            for (const row of manifest.rows) {
              await transaction.query(
                `INSERT INTO crm.n8n_command_operational_archives
               (command_id, archived_at, archived_by, reason_code, workflow_version)
               VALUES ($1,$2,$3,'legacy_transport_retired_outcome_unknown','waha-webjs-1')`,
                [row.command_id, archivedAt, access.actor.id],
              );
              await new PostgresAuditTrail(transaction).append({
                action,
                actor: access.actor.id,
                correlationId: input.correlationId,
                target: { id: row.command_id, type: 'n8n_command' },
                version: 1,
                reason: 'legacy_transport_retired_outcome_unknown',
              });
            }
            return { archivedCount: manifest.count, archivedAt };
          },
        );
      });
    },

    /** @param {{statusCode: number, readiness?: boolean, requestId?: string, correlationId?: string}} input */
    async recordApiFailure(input) {
      if (input.statusCode < 500) return;
      const at = clock();
      await database.transaction(async (/** @type {any} */ client) => {
        await recordIncident(client, {
          source: 'api',
          code: input.readiness ? 'API_NOT_READY' : 'API_5XX',
          eventKey: createHash('sha256')
            .update(`api:${randomUUID()}`)
            .digest('hex'),
          at,
          requestId: input.requestId,
          correlationId: input.correlationId,
        });
      });
    },
  });
}
