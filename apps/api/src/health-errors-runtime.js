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
  "DELETE FROM crm.operational_incident_receipts WHERE observed_at < now() - interval '30 days'",
  "DELETE FROM crm.operational_incident_history WHERE occurred_at < now() - interval '30 days'",
  "DELETE FROM crm.operational_incidents WHERE last_seen_at < now() - interval '30 days'",
  `UPDATE crm.operational_incidents i SET
     occurrences = r.total, first_seen_at = r.first_seen,
     version = nextval('crm.operational_incident_version')
   FROM (SELECT incident_id, count(*)::bigint AS total, min(observed_at) AS first_seen
         FROM crm.operational_incident_receipts GROUP BY incident_id) r
   WHERE i.id = r.incident_id
     AND (i.occurrences <> r.total OR i.first_seen_at <> r.first_seen)`,
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
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('operational-incidents', 0))",
  );
  for (const sql of RETENTION_SQL) await client.query(sql);
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

const SOURCE_FAILURES_SQL = `
  WITH sources AS (
    SELECT 'worker' AS source,
      CASE status WHEN 'retry' THEN 'WORKER_RETRY'
        WHEN 'dead_letter' THEN 'WORKER_DEAD_LETTER'
        ELSE 'WORKER_OUTCOME_UNKNOWN' END AS code,
      updated_at AS observed_at,
      'worker:' || id || ':' || status || ':' || attempt_count::text AS receipt
    FROM crm.outbox_jobs
    WHERE status IN ('retry', 'dead_letter', 'outcome_unknown')
      AND updated_at >= now() - interval '30 days'
    UNION ALL
    SELECT 'n8n',
      CASE status WHEN 'failed' THEN 'N8N_FAILED'
        WHEN 'outcome_unknown' THEN 'N8N_OUTCOME_UNKNOWN'
        ELSE 'N8N_PROCESSING_EXPIRED' END,
      CASE WHEN status = 'processing' THEN locked_until ELSE updated_at END,
      'n8n:' || command_id || ':' || status || ':' ||
        extract(epoch FROM CASE WHEN status = 'processing' THEN locked_until ELSE updated_at END)::text
    FROM crm.n8n_commands
    WHERE (status IN ('failed', 'outcome_unknown')
        OR (status = 'processing' AND locked_until < now()))
      AND updated_at >= now() - interval '30 days'
  ), candidates AS (
    SELECT source, code, observed_at,
      encode(sha256(convert_to(receipt, 'UTF8')), 'hex') AS event_key
    FROM sources
    WHERE observed_at <= now() AND observed_at >= now() - interval '30 days'
  )
  SELECT * FROM candidates c WHERE NOT EXISTS (
    SELECT 1 FROM crm.operational_incident_receipts r WHERE r.event_key = c.event_key
  ) ORDER BY observed_at ASC, event_key ASC LIMIT 501`;

const SELECT_INCIDENT_SQL = `SELECT i.*, coalesce((
  SELECT jsonb_agg(h.entry ORDER BY h.occurred_at, h.version)
  FROM (SELECT jsonb_build_object('status', status, 'at', occurred_at) AS entry,
          occurred_at, version
        FROM crm.operational_incident_history WHERE incident_id = i.id
          AND occurred_at >= now() - interval '30 days'
        ORDER BY version DESC LIMIT 50) h
), '[]'::jsonb) AS history FROM crm.operational_incidents i`;

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
      await database.transaction(cleanup);
    },
    /** @param {any} input */
    async list(input) {
      const auth = credentials(input, false);
      const status = input.status ?? 'all';
      if (status !== 'all' && !STATUSES.has(status))
        throw failure(400, 'INVALID_REQUEST');
      return database.transaction(async (/** @type {any} */ client) => {
        await identity.authorizeHealthErrors(auth, client);
        await cleanup(client);
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
          `${SELECT_INCIDENT_SQL} WHERE ($1 = 'all' OR i.status = $1)
             AND i.last_seen_at >= now() - interval '30 days'
           ORDER BY i.last_seen_at DESC, i.id LIMIT 100`,
          [status],
        );
        const counts = await client.query(
          'SELECT status, count(*)::int AS count FROM crm.operational_incidents GROUP BY status',
        );
        const summary = { new: 0, investigating: 0, resolved: 0 };
        for (const row of counts.rows) {
          if (STATUSES.has(row.status))
            summary[
              /** @type {'new'|'investigating'|'resolved'} */ (row.status)
            ] = Number(row.count);
        }
        return {
          items: result.rows.map(incidentView),
          summary,
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
            return incidentView(result.rows[0]);
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
