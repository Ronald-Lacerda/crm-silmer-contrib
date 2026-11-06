import { lockDashboardReader } from './dashboard-access.js';
import { DashboardError, dashboardPeriod } from './dashboard-runtime.js';
import { activeLeadLossSql, EFFECTIVE_HUMAN_SEND } from './lead-outcome-sql.js';

/** RFC 048 / ADR 061: the versioned business-hours policy every service
 * metric is measured with. The SQL function `crm.business_minutes_v1` is the
 * single source; this object only describes it to the client. */
export const BUSINESS_HOURS = Object.freeze({
  policy: 'expediente-v1',
  weekdays: Object.freeze([1, 2, 3, 4, 5]),
  blocks: Object.freeze([
    Object.freeze(['09:00', '12:00']),
    Object.freeze(['13:00', '18:00']),
  ]),
  unansweredThresholdMinutes: 15,
});

/** "Sem resposta agora" is a snapshot of open conversations with an owner
 * and no active declared loss (MET-08). */
const UNANSWERED_NOW_CONVERSATION = `candidates.terminal_at IS NULL
  AND candidates.archived_at IS NULL AND candidates.assigned_user_id IS NOT NULL
  AND NOT ${activeLeadLossSql('candidates.id')}`;

/** @param {unknown} value */
function minutes(value) {
  if (value === null || value === undefined) return null;
  return Math.round(Number(value) * 10) / 10;
}

/** @param {unknown} value */
function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new DashboardError(400, 'INVALID_FILTER');
  return value;
}

/** Service metrics of a São Paulo calendar window, in business minutes.
 * Cohort = seller handoffs created in the window; credit goes to who claimed
 * it. Time to claim runs from the request to the claim; the first response
 * starts at the claim (or the next customer message) so they never overlap. Unanswered episodes are dated and credited at the instant the wait
 * crossed the threshold, using the conversation's ownership history.
 * @param {{query:(sql:string,values?:unknown[])=>Promise<{rows:any[]}>}} database
 * @param {{from:string,to:string,actorId:string,manager:boolean,now:Date}} input
 */
export async function readServiceMetrics(database, input) {
  const from = calendarDay(input.from);
  const to = calendarDay(input.to);
  if (from > to) throw new DashboardError(400, 'INVALID_FILTER');
  const manager = input.manager === true;
  const result = await database.query(
    `WITH bounds AS (
       SELECT ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS from_at,
              (($2::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS to_at,
              $5::timestamptz AS now_at, $6::numeric AS threshold
     ), cohort AS (
       SELECT h.id, h.conversation_id, h.created_at, c.terminal_at,
              claim.assigned_user_id AS claimer, claim.occurred_at AS claimed_at
       FROM bounds
       JOIN crm.handoffs h ON h.target_role = 'Vendedor'
         AND h.created_at >= bounds.from_at AND h.created_at < bounds.to_at
         AND h.created_at <= bounds.now_at
       JOIN crm.conversations c ON c.id = h.conversation_id
       LEFT JOIN LATERAL (
         SELECT history.assigned_user_id, history.occurred_at
         FROM crm.handoff_history history
         WHERE history.handoff_id = h.id AND history.from_status = 'pending'
           AND history.to_status = 'accepted' AND history.assigned_user_id IS NOT NULL
           AND history.occurred_at <= bounds.now_at
         ORDER BY history.occurred_at, history.resulting_version LIMIT 1
       ) claim ON true
     ), claimed AS (
       -- RFC 048: the first response does not overlap the time to claim. It
       -- starts at the claim when a customer message is pending (no effective
       -- human reply after it) at that instant; otherwise at the first
       -- customer message after the claim. Without either there is nothing to
       -- answer yet: no sample and nothing open.
       SELECT cohort.claimer AS user_id,
              crm.business_minutes_v1(cohort.created_at, cohort.claimed_at)::float8 AS claim_minutes,
              CASE WHEN reply.at IS NOT NULL
                THEN crm.business_minutes_v1(started.at, reply.at)::float8 END AS reply_minutes,
              started.at IS NOT NULL AND reply.at IS NULL AND cohort.terminal_at IS NULL AS open,
              started.at IS NOT NULL AND reply.at IS NULL AND cohort.terminal_at IS NOT NULL
                AS closed_without_reply,
              CASE WHEN started.at IS NOT NULL AND reply.at IS NULL AND cohort.terminal_at IS NULL
                THEN crm.business_minutes_v1(started.at, bounds.now_at) END AS open_minutes
       FROM cohort CROSS JOIN bounds
       CROSS JOIN LATERAL (
         SELECT
           (SELECT max(i.occurred_at) FROM crm.messages i
            WHERE i.conversation_id = cohort.conversation_id AND i.direction = 'inbound'
              AND i.author_kind = 'contact' AND i.occurred_at <= cohort.claimed_at) AS last_inbound,
           (SELECT max(coalesce(r.sent_at, r.occurred_at)) FROM crm.messages r
            WHERE r.conversation_id = cohort.conversation_id AND ${EFFECTIVE_HUMAN_SEND('r')}
              AND coalesce(r.sent_at, r.occurred_at) <= cohort.claimed_at) AS last_reply,
           (SELECT min(i.occurred_at) FROM crm.messages i
            WHERE i.conversation_id = cohort.conversation_id AND i.direction = 'inbound'
              AND i.author_kind = 'contact' AND i.occurred_at > cohort.claimed_at
              AND i.occurred_at <= bounds.now_at) AS next_inbound
       ) at_claim
       CROSS JOIN LATERAL (
         SELECT CASE
           WHEN at_claim.last_inbound IS NOT NULL
             AND (at_claim.last_reply IS NULL OR at_claim.last_reply < at_claim.last_inbound)
           THEN cohort.claimed_at ELSE at_claim.next_inbound END AS at
       ) started
       LEFT JOIN LATERAL (
         SELECT coalesce(m.sent_at, m.occurred_at) AS at FROM crm.messages m
         WHERE m.conversation_id = cohort.conversation_id AND ${EFFECTIVE_HUMAN_SEND('m')}
           AND coalesce(m.sent_at, m.occurred_at) >= started.at
           AND coalesce(m.sent_at, m.occurred_at) <= bounds.now_at
         ORDER BY coalesce(m.sent_at, m.occurred_at), m.id LIMIT 1
       ) reply ON true
       WHERE cohort.claimer IS NOT NULL
     ), service AS (
       SELECT user_id,
              count(*)::integer AS claim_samples,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY claim_minutes) AS claim_median,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY claim_minutes) AS claim_p90,
              count(reply_minutes)::integer AS reply_samples,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY reply_minutes) AS reply_median,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY reply_minutes) AS reply_p90,
              count(*) FILTER (WHERE open)::integer AS open_count,
              max(open_minutes) AS oldest_open,
              count(*) FILTER (WHERE closed_without_reply)::integer AS closed_without_reply
       FROM claimed GROUP BY user_id
     ), candidates AS (
       SELECT c.id, c.assigned_user_id, c.terminal_at, c.archived_at
       FROM crm.conversations c CROSS JOIN bounds
       WHERE c.automation_state = 'human' AND c.opened_at <= bounds.now_at
         AND (c.terminal_at IS NULL OR c.terminal_at >= bounds.from_at)
     ), ownership AS (
       -- Who owned the conversation from when: claim/transfer of a handoff,
       -- takeover, panel transfer and any human send, which also assigns the
       -- conversation to its author. Limitation: a panel transfer stores its
       -- target only in the free-text audit reason ("... (repasse para <id>)"),
       -- parsed below; if that format changes or the id is unknown, the
       -- episode falls back to the current owner.
       SELECT h.conversation_id, history.assigned_user_id AS user_id, history.occurred_at
       FROM candidates JOIN crm.handoffs h ON h.conversation_id = candidates.id
       JOIN crm.handoff_history history ON history.handoff_id = h.id
       CROSS JOIN bounds
       WHERE history.to_status = 'accepted' AND history.assigned_user_id IS NOT NULL
         AND history.occurred_at <= bounds.now_at
       UNION ALL
       SELECT event.target_id,
              CASE WHEN event.action = 'conversation.takeover' THEN event.actor_id
                ELSE substring(event.reason FROM '[(]repasse para ([^()]+)[)]$') END,
              event.occurred_at
       FROM candidates JOIN crm.audit_events event
         ON event.target_type = 'conversation' AND event.target_id = candidates.id
        AND event.action IN ('conversation.takeover','conversation.transferred')
       CROSS JOIN bounds WHERE event.occurred_at <= bounds.now_at
       UNION ALL
       SELECT m.conversation_id, m.author_id, m.occurred_at
       FROM candidates JOIN crm.messages m ON m.conversation_id = candidates.id
       CROSS JOIN bounds
       WHERE m.direction = 'outbound' AND m.author_kind = 'human'
         AND m.occurred_at <= bounds.now_at
     ), human_start AS (
       SELECT conversation_id, min(occurred_at) AS started_at
       FROM ownership GROUP BY conversation_id
     ), responses AS (
       SELECT m.conversation_id, coalesce(m.sent_at, m.occurred_at) AS at
       FROM candidates JOIN crm.messages m ON m.conversation_id = candidates.id
       CROSS JOIN bounds
       WHERE ${EFFECTIVE_HUMAN_SEND('m')} AND coalesce(m.sent_at, m.occurred_at) <= bounds.now_at
     ), waits AS (
       -- One wait per gap between effective human replies, however many
       -- customer messages it holds.
       SELECT inbound.conversation_id, min(inbound.occurred_at) AS first_at
       FROM candidates JOIN crm.messages inbound ON inbound.conversation_id = candidates.id
       CROSS JOIN bounds
       LEFT JOIN LATERAL (
         SELECT max(r.at) AS at FROM responses r
         WHERE r.conversation_id = inbound.conversation_id AND r.at < inbound.occurred_at
       ) previous ON true
       WHERE inbound.direction = 'inbound' AND inbound.author_kind = 'contact'
         AND inbound.occurred_at <= bounds.now_at
       GROUP BY inbound.conversation_id, previous.at
     ), periods AS (
       -- A wait starts no earlier than the human mode (the time before a
       -- claim is measured by the claim metric) and ends at the next
       -- effective human reply, at the closing of the cycle or now.
       SELECT waits.conversation_id, started.at AS started_at,
              reply.at IS NULL AND candidates.terminal_at IS NULL AS open,
              least(coalesce(reply.at, 'infinity'::timestamptz),
                    coalesce(candidates.terminal_at, 'infinity'::timestamptz),
                    bounds.now_at) AS ended_at
       FROM waits JOIN candidates ON candidates.id = waits.conversation_id
       JOIN human_start ON human_start.conversation_id = waits.conversation_id
       CROSS JOIN bounds
       CROSS JOIN LATERAL (
         SELECT greatest(waits.first_at, human_start.started_at) AS at
       ) started
       LEFT JOIN LATERAL (
         SELECT min(r.at) AS at FROM responses r
         WHERE r.conversation_id = waits.conversation_id AND r.at > waits.first_at
       ) reply ON true
     ), now_open AS (
       SELECT candidates.assigned_user_id AS user_id, count(*)::integer AS count,
              max(crm.business_minutes_v1(periods.started_at, bounds.now_at)) AS oldest
       FROM periods JOIN candidates ON candidates.id = periods.conversation_id
       CROSS JOIN bounds
       WHERE periods.open AND ${UNANSWERED_NOW_CONVERSATION}
         AND crm.business_minutes_v1(periods.started_at, bounds.now_at) > bounds.threshold
       GROUP BY candidates.assigned_user_id
     ), episodes AS (
       SELECT periods.conversation_id,
              crm.business_deadline_v1(periods.started_at, bounds.threshold) AS crossed_at
       FROM periods CROSS JOIN bounds
       WHERE crm.business_minutes_v1(periods.started_at, periods.ended_at) > bounds.threshold
     ), episode_counts AS (
       SELECT credited.user_id, count(*)::integer AS count
       FROM episodes JOIN candidates ON candidates.id = episodes.conversation_id
       CROSS JOIN bounds
       LEFT JOIN LATERAL (
         SELECT o.user_id FROM ownership o
         WHERE o.conversation_id = episodes.conversation_id
           AND o.occurred_at <= episodes.crossed_at
         ORDER BY o.occurred_at DESC LIMIT 1
       ) owner_then ON true
       CROSS JOIN LATERAL (
         SELECT coalesce((SELECT u.id FROM crm.users u WHERE u.id = owner_then.user_id),
                         candidates.assigned_user_id) AS user_id
       ) credited
       WHERE episodes.crossed_at >= bounds.from_at AND episodes.crossed_at < bounds.to_at
         AND credited.user_id IS NOT NULL
       GROUP BY credited.user_id
     ), metric_users AS (
       SELECT user_id FROM service UNION SELECT user_id FROM now_open
       UNION SELECT user_id FROM episode_counts
     ), people AS (
       SELECT u.id AS user_id, u.name, u.disabled_at IS NULL AS active,
              coalesce(s.claim_samples,0) AS claim_samples, s.claim_median, s.claim_p90,
              coalesce(s.reply_samples,0) AS reply_samples, s.reply_median, s.reply_p90,
              coalesce(s.open_count,0) AS open_count, s.oldest_open,
              coalesce(s.closed_without_reply,0) AS closed_without_reply,
              coalesce(now_open.count,0) AS now_count, now_open.oldest AS now_oldest,
              coalesce(episode_counts.count,0) AS episode_count
       FROM crm.users u LEFT JOIN crm.user_functions f ON f.user_id = u.id
       LEFT JOIN service s ON s.user_id = u.id
       LEFT JOIN now_open ON now_open.user_id = u.id
       LEFT JOIN episode_counts ON episode_counts.user_id = u.id
       WHERE ($4::boolean OR u.id = $3)
         AND (f.function_name = 'Vendedor' OR u.id IN (SELECT user_id FROM metric_users))
         AND (u.disabled_at IS NULL OR u.id IN (SELECT user_id FROM metric_users))
     ), unclaimed AS (
       SELECT count(*)::integer AS count,
              max(crm.business_minutes_v1(h.created_at, bounds.now_at)) AS oldest
       FROM crm.handoffs h JOIN crm.conversations c ON c.id = h.conversation_id
       CROSS JOIN bounds
       WHERE $4::boolean AND h.status = 'pending' AND h.target_role = 'Vendedor'
         AND c.assigned_user_id IS NULL AND c.automation_state = 'human'
         AND c.terminal_at IS NULL AND c.archived_at IS NULL
         AND h.created_at <= bounds.now_at
     )
     SELECT coalesce((SELECT jsonb_agg(to_jsonb(people) ORDER BY name, user_id)
                      FROM people), '[]'::jsonb) AS people,
            (SELECT to_jsonb(unclaimed) FROM unclaimed) AS unclaimed`,
    [
      from,
      to,
      input.actorId,
      manager,
      input.now.toISOString(),
      BUSINESS_HOURS.unansweredThresholdMinutes,
    ],
  );
  const report = result.rows[0] ?? {};
  const rows = (report.people ?? []).map((/** @type {any} */ row) => {
    const replySamples = Number(row.reply_samples ?? 0);
    const claimSamples = Number(row.claim_samples ?? 0);
    const nowCount = Number(row.now_count ?? 0);
    const openCount = Number(row.open_count ?? 0);
    return {
      userId: row.user_id,
      name: row.name,
      active: row.active === true,
      firstResponse: {
        samples: replySamples,
        medianMinutes: replySamples ? minutes(row.reply_median) : null,
        p90Minutes: replySamples >= 5 ? minutes(row.reply_p90) : null,
        openCount,
        oldestOpenMinutes: openCount ? minutes(row.oldest_open) : null,
        closedWithoutReply: Number(row.closed_without_reply ?? 0),
      },
      claim: {
        samples: claimSamples,
        medianMinutes: claimSamples ? minutes(row.claim_median) : null,
        p90Minutes: claimSamples >= 5 ? minutes(row.claim_p90) : null,
      },
      unansweredNow: {
        count: nowCount,
        oldestWaitingMinutes: nowCount ? minutes(row.now_oldest) : null,
      },
      unansweredEpisodes: { count: Number(row.episode_count ?? 0) },
    };
  });
  const unclaimedCount = Number(report.unclaimed?.count ?? 0);
  return {
    from,
    to,
    scope: manager ? 'team' : 'self',
    rows,
    ...(manager
      ? {
          team: {
            unclaimedHandoffs: {
              count: unclaimedCount,
              oldestWaitingMinutes: unclaimedCount
                ? minutes(report.unclaimed?.oldest)
                : null,
            },
          },
        }
      : {}),
  };
}

/** MET-06 closed list; aggregations use only the code, never the note. */
export const LEAD_LOSS_REASONS = Object.freeze([
  'preco',
  'prazo',
  'concorrente',
  'silencio',
  'indisponivel',
  'outro',
]);

/** @param {any} row */
function byReason(row) {
  return Object.fromEntries(
    LEAD_LOSS_REASONS.map((reason) => [reason, Number(row?.[reason] ?? 0)]),
  );
}

/** Declared losses of a São Paulo calendar window (MET-06–08). A loss is
 * effective unless the next version is a manual reopening (a correction).
 * Each conversation counts once, through its latest effective loss marked in
 * the window: that loss gives the owner (who owned the conversation when it
 * was marked) and the reason. A loss the customer reopened by writing again
 * still counts and is also reported in `reopenedByCustomerCount`. The
 * free-text note is never read here.
 * @param {{query:(sql:string,values?:unknown[])=>Promise<{rows:any[]}>}} database
 * @param {{from:string,to:string,actorId:string,manager:boolean,now:Date}} input
 */
export async function readLossMetrics(database, input) {
  const from = calendarDay(input.from);
  const to = calendarDay(input.to);
  if (from > to) throw new DashboardError(400, 'INVALID_FILTER');
  const manager = input.manager === true;
  const counted = LEAD_LOSS_REASONS.map(
    (reason) =>
      `count(*) FILTER (WHERE reason_code = '${reason}')::integer AS ${reason}`,
  ).join(', ');
  const kept = LEAD_LOSS_REASONS.map(
    (reason) => `coalesce(l.${reason}, 0) AS ${reason}`,
  ).join(', ');
  const result = await database.query(
    `WITH bounds AS (
       SELECT ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS from_at,
              (($2::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS to_at,
              $5::timestamptz AS now_at
     ), effective AS (
       SELECT DISTINCT ON (loss.conversation_id) loss.conversation_id, loss.owner_id,
              loss.reason_code, loss.last_inbound_message_id
       FROM crm.lead_outcome_events loss CROSS JOIN bounds
       WHERE loss.outcome = 'lost' AND loss.occurred_at >= bounds.from_at
         AND loss.occurred_at < bounds.to_at AND loss.occurred_at <= bounds.now_at
         AND NOT EXISTS (
           SELECT 1 FROM crm.lead_outcome_events correction
           WHERE correction.conversation_id = loss.conversation_id
             AND correction.version = loss.version + 1
             AND correction.outcome = 'reopened'
             AND correction.occurred_at <= bounds.now_at)
       ORDER BY loss.conversation_id, loss.version DESC
     ), classified AS (
       SELECT effective.owner_id, effective.reason_code,
              effective.last_inbound_message_id IS DISTINCT FROM (
                SELECT customer.id FROM crm.messages customer
                WHERE customer.conversation_id = effective.conversation_id
                  AND customer.direction = 'inbound' AND customer.author_kind = 'contact'
                  AND customer.occurred_at <= bounds.now_at
                ORDER BY customer.occurred_at DESC, customer.id DESC LIMIT 1
              ) AS reopened_by_customer
       FROM effective CROSS JOIN bounds
     ), losses AS (
       SELECT owner_id AS user_id, count(*)::integer AS lost_count,
              count(*) FILTER (WHERE reopened_by_customer)::integer AS reopened_count,
              ${counted}
       FROM classified GROUP BY owner_id
     ), people AS (
       SELECT u.id AS user_id, u.name, u.disabled_at IS NULL AS active,
              coalesce(l.lost_count, 0) AS lost_count,
              coalesce(l.reopened_count, 0) AS reopened_count, ${kept}
       FROM crm.users u LEFT JOIN crm.user_functions f ON f.user_id = u.id
       LEFT JOIN losses l ON l.user_id = u.id
       WHERE ($4::boolean OR u.id = $3)
         AND (f.function_name = 'Vendedor' OR l.user_id IS NOT NULL)
         AND (u.disabled_at IS NULL OR l.user_id IS NOT NULL)
     )
     SELECT coalesce((SELECT jsonb_agg(to_jsonb(people) ORDER BY name, user_id)
                      FROM people), '[]'::jsonb) AS people`,
    [from, to, input.actorId, manager, input.now.toISOString()],
  );
  /** @type {Array<{userId:string,name:string|null,active:boolean,lostCount:number,reopenedByCustomerCount:number,byReason:Record<string,number>}>} */
  const rows = (result.rows[0]?.people ?? []).map((/** @type {any} */ row) => ({
    userId: row.user_id,
    name: row.name,
    active: row.active === true,
    lostCount: Number(row.lost_count ?? 0),
    reopenedByCustomerCount: Number(row.reopened_count ?? 0),
    byReason: byReason(row),
  }));
  /** @param {(row: typeof rows[number]) => number} pick */
  const total = (pick) => rows.reduce((sum, row) => sum + pick(row), 0);
  return {
    from,
    to,
    scope: manager ? 'team' : 'self',
    rows,
    ...(manager
      ? {
          totals: {
            lostCount: total((row) => row.lostCount),
            reopenedByCustomerCount: total(
              (row) => row.reopenedByCustomerCount,
            ),
            byReason: Object.fromEntries(
              LEAD_LOSS_REASONS.map((reason) => [
                reason,
                total((row) => row.byReason[reason]),
              ]),
            ),
          },
        }
      : {}),
  };
}

/** @param {any} database @param {{access:any,clock?:()=>Date}} options */
export function createDashboardMetricsRuntime(database, options) {
  const clock = options.clock ?? (() => new Date());
  const access = options.access;
  return Object.freeze({
    /** @param {any} input */
    authorizeRead: (input) => access.authorizeRead(input),
    /** @param {{actor:any,days?:number}} input */
    async service(input) {
      const now = clock();
      const period = dashboardPeriod(now, input.days ?? 7);
      return database.transaction(async (/** @type {any} */ client) => {
        const reader = await lockDashboardReader(client, input.actor);
        const report = await readServiceMetrics(client, {
          from: period.from,
          to: period.to,
          actorId: reader.id,
          manager: reader.scope === 'team',
          now,
        });
        return {
          from: report.from,
          to: report.to,
          days: period.days,
          scope: report.scope,
          generatedAt: now.toISOString(),
          businessHours: BUSINESS_HOURS,
          rows: report.rows,
          ...(report.team ? { team: report.team } : {}),
        };
      });
    },
    /** @param {{actor:any,days?:number}} input */
    async losses(input) {
      const now = clock();
      const period = dashboardPeriod(now, input.days ?? 7);
      return database.transaction(async (/** @type {any} */ client) => {
        const reader = await lockDashboardReader(client, input.actor);
        const report = await readLossMetrics(client, {
          from: period.from,
          to: period.to,
          actorId: reader.id,
          manager: reader.scope === 'team',
          now,
        });
        return {
          from: report.from,
          to: report.to,
          days: period.days,
          scope: report.scope,
          generatedAt: now.toISOString(),
          rows: report.rows,
          ...(report.totals ? { totals: report.totals } : {}),
        };
      });
    },
  });
}
