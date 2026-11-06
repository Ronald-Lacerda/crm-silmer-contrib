import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import { authorize } from '@crm-silmer/identity-access';
import {
  fingerprintCommand,
  PostgresIdempotencyRecordStore,
} from '@crm-silmer/integration-reliability';
import {
  operationalDay,
  PostgresOrderRepository,
  promisedDeliveryOn,
} from '@crm-silmer/orders';

import { activeLeadLossSql } from './lead-outcome-sql.js';

export const DASHBOARD_ACTION_LIMIT = 100;
export const DASHBOARD_FOLLOWUP_HOURS = 72;

export class DashboardError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'DashboardError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** @param {unknown} value @param {number} [minimum] */
function version(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new DashboardError(400, 'INVALID_EXPECTED_VERSION');
  }
  return Number(value);
}

/** @param {unknown} value @param {number} [max] */
function identifier(value, max = 255) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new DashboardError(400, 'INVALID_REQUEST');
  }
  return value;
}

/** @param {Date|string|null|undefined} value */
function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

/** @param {unknown} value */
function calendarDay(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new DashboardError(400, 'INVALID_FILTER');
  }
  return value;
}

/** @param {Date} now @param {unknown} days */
export function dashboardPeriod(now, days = 7) {
  if (days !== 7 && days !== 30) {
    throw new DashboardError(400, 'INVALID_FILTER');
  }
  const to = operationalDay(now);
  const from = new Date(
    Date.parse(`${to}T00:00:00Z`) - (Number(days) - 1) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return { from, to, days: Number(days), timeZone: 'America/Sao_Paulo' };
}

/** Re-read the active role, including on an idempotent replay.
 * @param {any} client @param {any} actor @param {boolean} write
 */
async function lockActor(client, actor, write) {
  if (actor?.kind !== 'human' || !actor.id) {
    throw new DashboardError(403, 'FORBIDDEN');
  }
  const result = await client.query(
    `SELECT u.id, f.function_name
     FROM crm.users u JOIN crm.user_functions f ON f.user_id = u.id
     WHERE u.id = $1 AND u.disabled_at IS NULL FOR SHARE OF u, f`,
    [actor.id],
  );
  const row = result.rows[0];
  if (!row) throw new DashboardError(403, 'FORBIDDEN');
  const grants = await client.query(
    `SELECT capability FROM crm.user_capabilities
     WHERE user_id = $1 FOR SHARE`,
    [actor.id],
  );
  const live = {
    id: actor.id,
    kind: /** @type {const} */ ('human'),
    functionName: row.function_name,
    capabilities: grants.rows.map(
      (/** @type {any} */ grant) => grant.capability,
    ),
  };
  authorize(live, write ? 'conversation.takeover' : 'conversation.read');
  return live;
}

/** Shared commercial calculation for UI and the daily checkpoint.
 * Dates are inclusive São Paulo commercial days. No current owner backfill.
 * @param {{query:(sql:string,values?:unknown[])=>Promise<{rows:any[]}>}} database
 * @param {{from:string,to:string,actorId?:string,manager?:boolean}} input
 */
export async function readDashboardPerformance(database, input) {
  const from = calendarDay(input.from);
  const to = calendarDay(input.to);
  if (from > to) throw new DashboardError(400, 'INVALID_FILTER');
  const manager = input.manager === true;
  const actorId = manager ? (input.actorId ?? null) : identifier(input.actorId);
  const result = await database.query(
    `WITH sales AS (
       SELECT * FROM crm.orders
       WHERE status = 'confirmado' AND NOT is_test
         AND order_date BETWEEN $1::date AND $2::date
     ), sold AS (
       SELECT sales_owner_id AS user_id, count(*)::integer confirmed_count,
              coalesce(sum(final_amount_cents),0)::bigint sold_amount_cents,
              count(DISTINCT conversation_id)::integer conversations_with_sale_count
       FROM sales WHERE origin = 'atendimento' AND sales_owner_id IS NOT NULL
       GROUP BY sales_owner_id
     ), attended AS (
       SELECT author_id AS user_id, count(DISTINCT conversation_id)::integer attended_count
       FROM crm.messages
       WHERE direction = 'outbound' AND author_kind = 'human' AND status = 'sent'
         AND coalesce(delivery_status,'sent') NOT IN ('failed','outcome_unknown')
         AND coalesce(sent_at,occurred_at) >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
         AND coalesce(sent_at,occurred_at) < (($2::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
       GROUP BY author_id
     ), assumption_events AS (
       SELECT history.actor_id AS user_id, handoff.conversation_id
       FROM crm.handoff_history history JOIN crm.handoffs handoff ON handoff.id = history.handoff_id
       WHERE history.from_status = 'pending' AND history.to_status = 'accepted'
         AND history.assigned_user_id = history.actor_id
         AND history.occurred_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
         AND history.occurred_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
       UNION
       SELECT actor_id AS user_id, target_id AS conversation_id
       FROM crm.audit_events
       WHERE action = 'conversation.takeover' AND target_type = 'conversation'
         AND occurred_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
         AND occurred_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
     ), assumed AS (
       SELECT user_id, count(DISTINCT conversation_id)::integer assumed_count
       FROM assumption_events GROUP BY user_id
     ), closed AS (
       SELECT closed_by AS user_id, count(DISTINCT id)::integer closed_count
       FROM crm.conversations WHERE state = 'encerrada' AND closed_by IS NOT NULL
         AND terminal_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
         AND terminal_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
       GROUP BY closed_by
     ), metric_users AS (
       SELECT user_id FROM sold UNION SELECT user_id FROM attended
       UNION SELECT user_id FROM assumed UNION SELECT user_id FROM closed
     ), people AS (
       SELECT u.id AS user_id, u.name, u.disabled_at IS NULL AS active,
              coalesce(sold.sold_amount_cents,0)::bigint sold_amount_cents,
              coalesce(sold.confirmed_count,0)::integer confirmed_count,
              coalesce(sold.conversations_with_sale_count,0)::integer conversations_with_sale_count,
              coalesce(attended.attended_count,0)::integer attended_count,
              coalesce(assumed.assumed_count,0)::integer assumed_count,
              coalesce(closed.closed_count,0)::integer closed_count
       FROM crm.users u LEFT JOIN crm.user_functions f ON f.user_id = u.id
       LEFT JOIN sold ON sold.user_id = u.id
       LEFT JOIN attended ON attended.user_id = u.id
       LEFT JOIN assumed ON assumed.user_id = u.id
       LEFT JOIN closed ON closed.user_id = u.id
       WHERE ($4::boolean OR u.id = $3)
         AND (f.function_name = 'Vendedor' OR u.id IN (SELECT user_id FROM metric_users))
         AND (u.disabled_at IS NULL OR u.id IN (SELECT user_id FROM metric_users))
     )
     SELECT coalesce((SELECT jsonb_agg(to_jsonb(people) ORDER BY sold_amount_cents DESC,name,user_id)
                      FROM people),'[]'::jsonb) AS people,
       (SELECT jsonb_build_object('soldAmountCents',coalesce(sum(final_amount_cents),0),
                                 'confirmedCount',count(*)) FROM sales
        WHERE $4::boolean OR sales_owner_id = $3) AS totals,
       (SELECT jsonb_build_object('soldAmountCents',coalesce(sum(final_amount_cents),0),
                                 'confirmedCount',count(*)) FROM sales
        WHERE $4::boolean AND origin = 'loja') AS store,
       (SELECT jsonb_build_object('soldAmountCents',coalesce(sum(final_amount_cents),0),
                                 'confirmedCount',count(*)) FROM sales
        WHERE $4::boolean AND origin = 'atendimento' AND sales_owner_id IS NULL) AS unattributed`,
    [from, to, actorId, manager],
  );
  const report = result.rows[0] ?? {};
  /** @param {any} value */
  const amount = (value) => ({
    soldAmountCents: Number(value?.soldAmountCents ?? 0),
    confirmedCount: Number(value?.confirmedCount ?? 0),
  });
  const rows = (report.people ?? []).map((/** @type {any} */ row) => {
    const soldAmountCents = Number(row.sold_amount_cents ?? 0);
    const confirmedCount = Number(row.confirmed_count ?? 0);
    return {
      userId: row.user_id,
      name: row.name,
      active: row.active === true,
      soldAmountCents,
      confirmedCount,
      averageTicketCents: confirmedCount
        ? Math.round(soldAmountCents / confirmedCount)
        : 0,
      attendedCount: Number(row.attended_count ?? 0),
      assumedCount: Number(row.assumed_count ?? 0),
      closedCount: Number(row.closed_count ?? 0),
      conversationsWithSaleCount: Number(
        row.conversations_with_sale_count ?? 0,
      ),
    };
  });
  const unattributed = amount(report.unattributed);
  return {
    from,
    to,
    scope: manager ? 'team' : 'self',
    timeZone: 'America/Sao_Paulo',
    rows,
    totals: amount(report.totals),
    store: amount(report.store),
    unattributed,
    coverage: {
      basis: 'owner_captured_at_confirmation',
      historicalAttribution: 'unattributed_without_evidence',
      unattributedConfirmedCount: unattributed.confirmedCount,
    },
  };
}

const LAST_MESSAGE_JOIN = `LEFT JOIN LATERAL (
  SELECT m.id AS message_id, m.direction AS last_direction,
         m.author_kind AS last_author_kind, m.status AS last_status,
         m.delivery_status AS last_delivery_status, m.occurred_at AS last_occurred_at,
         m.sent_at AS last_sent_at
  FROM crm.messages m WHERE m.conversation_id = c.id
  ORDER BY m.occurred_at DESC,m.id DESC LIMIT 1
) last_message ON true`;

/** @param {any} row */
function sourceRevision(row) {
  return `message:${row.message_id ?? 'none'}:${row.last_status ?? 'none'}:${row.last_delivery_status ?? 'none'}`;
}

/** @param {any} item @param {any} row @param {Date} now */
function withDecision(item, row, now) {
  item.decisionVersion = Number(row.decision_version ?? 0);
  item.remindAt = null;
  item.deferred = false;
  if (
    Number(row.decision_target_version) !== item.targetVersion ||
    row.decision_source_revision !== item.sourceRevision
  )
    return item;
  if (row.decision_kind === 'dismiss' && item.kind === 'followup') return null;
  if (!['schedule', 'snooze'].includes(row.decision_kind)) return item;
  item.remindAt = iso(row.decision_remind_at);
  item.deferred = Boolean(
    item.remindAt && Date.parse(item.remindAt) > now.getTime(),
  );
  if (row.decision_kind === 'schedule') {
    item.kind = 'reminder';
    item.subtitle = 'Retorno agendado por você';
    item.dueAt = item.remindAt;
  }
  return item;
}

/** No content decryption is needed to explain why a conversation needs action.
 * @param {any} row @param {Date} now
 */
export function projectDashboardConversation(row, now) {
  const handoff =
    row.handoff_id &&
    row.handoff_status === 'pending' &&
    !row.assigned_user_id &&
    row.handoff_target_role === 'Vendedor' &&
    row.automation_state === 'human';
  const unknown =
    row.last_status === 'outcome_unknown' ||
    row.last_delivery_status === 'outcome_unknown';
  const failed =
    row.last_status === 'failed' || row.last_delivery_status === 'failed';
  const pendingSend =
    row.last_author_kind === 'human' &&
    ['queued', 'sending'].includes(row.last_status);
  const recovery =
    row.last_direction === 'outbound' && (unknown || failed || pendingSend);
  const sent =
    row.last_direction === 'outbound' &&
    row.last_author_kind === 'human' &&
    row.last_status === 'sent' &&
    !['failed', 'outcome_unknown'].includes(row.last_delivery_status);
  const since = iso(row.last_sent_at ?? row.last_occurred_at);
  const scheduled =
    row.decision_kind === 'schedule' &&
    Number(row.decision_target_version) === Number(row.version) &&
    row.decision_source_revision === sourceRevision(row);
  const kind = handoff
    ? 'handoff'
    : row.last_direction === 'inbound' || recovery
      ? 'reply'
      : sent &&
          since &&
          now.getTime() - Date.parse(since) >=
            DASHBOARD_FOLLOWUP_HOURS * 3_600_000
        ? 'followup'
        : scheduled
          ? 'reminder'
          : null;
  if (!kind) return null;
  const item = {
    id: handoff ? `handoff:${row.handoff_id}` : `conversation:${row.id}`,
    kind,
    reason: recovery
      ? unknown
        ? 'send_unknown'
        : failed
          ? 'send_failure'
          : 'send_pending'
      : kind === 'reply'
        ? 'awaiting_reply'
        : kind,
    targetType: 'conversation',
    targetId: row.id,
    conversationId: row.id,
    targetVersion: Number(row.version),
    sourceRevision: handoff
      ? `handoff:${row.handoff_version}:${sourceRevision(row)}`
      : sourceRevision(row),
    title: row.display_name || 'Conversa sem nome',
    subtitle: handoff
      ? 'Aguardando alguém assumir'
      : recovery
        ? unknown
          ? 'Resultado do envio desconhecido; confira sem reenviar'
          : failed
            ? 'Envio falhou; confira a conversa'
            : 'Envio aguardando confirmação'
        : kind === 'reply'
          ? 'Cliente espera sua resposta'
          : kind === 'followup'
            ? 'Última mensagem humana sem resposta há 3 dias ou mais'
            : 'Retorno agendado por você',
    attentionSince: handoff ? iso(row.handoff_created_at) : since,
    dueAt: handoff ? iso(row.handoff_due_at) : null,
    ...(handoff
      ? {
          handoff: { id: row.handoff_id, version: Number(row.handoff_version) },
        }
      : {}),
  };
  return withDecision(item, row, now);
}

/** @param {any} row @param {any} order @param {Date} now */
function projectOrder(row, order, now) {
  const pending = row.status === 'pendente';
  const item = {
    id: `order:${row.id}`,
    kind: pending ? 'pending_order' : 'order_followup',
    targetType: 'order',
    targetId: row.id,
    targetVersion: Number(row.version),
    sourceRevision: `order:${row.version}`,
    title:
      row.display_name ||
      order.ficha?.summary?.cliente ||
      `Pedido ${row.number}`,
    subtitle: pending
      ? `${row.number} · pedido a completar`
      : `${row.number} · conferir pagamento e entrega`,
    conversationId: row.conversation_id ?? null,
    attentionSince: iso(row.confirmed_at ?? row.created_at),
    dueAt: null,
    order: {
      id: row.id,
      number: row.number,
      status: row.status,
      finalAmountCents:
        row.final_amount_cents === null ? null : Number(row.final_amount_cents),
      totalPieces: Number(row.total_pieces),
      paidOn: row.paid_on ?? null,
      deliveredOn: row.delivered_on ?? null,
      paymentReviewRequired: row.finance_payment_review_required === true,
      paymentCondition: row.payment_condition ?? null,
      promisedDeliveryOn: promisedDeliveryOn(order),
      version: Number(row.version),
    },
  };
  return withDecision(item, row, now);
}

const DECISION_FIELDS = `d.version AS decision_version, d.target_version AS decision_target_version,
  d.source_revision AS decision_source_revision, d.decision AS decision_kind,
  d.remind_at AS decision_remind_at`;

/** @param {any} database @param {{access:any,orderEnvelopeKey:Buffer,idempotencyEnvelopeKey:Buffer,clock?:()=>Date,loadOrder?:(client:any,id:string)=>Promise<any>}} options */
export function createDashboardRuntime(database, options) {
  const clock = options.clock ?? (() => new Date());
  const access = options.access;
  /** @param {any} client @param {string} id */
  const loadOrder =
    options.loadOrder ??
    (async (client, id) => {
      const bound = {
        query: client.query.bind(client),
        transaction: async (/** @type {any} */ work) => work(client),
      };
      return new PostgresOrderRepository({
        database: bound,
        envelopeKey: options.orderEnvelopeKey,
      }).findById(id);
    });
  return Object.freeze({
    /** @param {any} input */
    authorizeRead: (input) => access.authorizeRead(input),
    /** @param {any} input */
    authorizeWrite: (input) => access.authorizeWrite(input),
    /** @param {{actor:any}} input */
    async actions(input) {
      const now = clock();
      return database.transaction(async (/** @type {any} */ client) => {
        const actor = await lockActor(client, input.actor, false);
        const [conversations, orders] = await Promise.all([
          client.query(
            `SELECT c.id,c.version,c.assigned_user_id,c.automation_state,contact.display_name,last_message.*,lead_loss.lead_loss_active,
                    h.id AS handoff_id,h.version AS handoff_version,h.status AS handoff_status,
                    h.created_at AS handoff_created_at,h.due_at AS handoff_due_at,h.target_role AS handoff_target_role,${DECISION_FIELDS}
             FROM crm.conversations c
             JOIN crm.contact_identities identity ON identity.id = c.contact_identity_id
             JOIN crm.contacts contact ON contact.id = identity.current_contact_id
             ${LAST_MESSAGE_JOIN}
             LEFT JOIN LATERAL (SELECT ${activeLeadLossSql('c.id')} AS lead_loss_active) lead_loss ON true
             LEFT JOIN LATERAL (SELECT * FROM crm.handoffs active WHERE active.conversation_id=c.id
               AND active.status='pending' AND active.target_role='Vendedor' ORDER BY active.created_at DESC LIMIT 1) h ON true
             LEFT JOIN crm.dashboard_action_decisions d ON d.user_id=$1
               AND d.action_id=CASE WHEN c.assigned_user_id IS NULL AND h.id IS NOT NULL
                 THEN 'handoff:' || h.id ELSE 'conversation:' || c.id END
             WHERE c.archived_at IS NULL AND c.terminal_at IS NULL
               AND c.state NOT IN ('encerrada','sem_lead','convertida_em_lead')
               AND ((c.assigned_user_id=$1 AND c.automation_state='human')
                 OR (c.assigned_user_id IS NULL AND h.id IS NOT NULL AND c.automation_state='human'))
               AND (h.id IS NOT NULL OR last_direction='inbound'
                 OR (last_direction='outbound' AND
                     ((last_author_kind='human' AND last_status IN ('queued','sending'))
                      OR last_status IN ('failed','outcome_unknown')
                      OR last_delivery_status IN ('failed','outcome_unknown')))
                 OR (last_direction='outbound' AND last_author_kind='human' AND last_status='sent'
                     AND coalesce(last_delivery_status,'sent') NOT IN ('failed','outcome_unknown')
                     AND coalesce(last_sent_at,last_occurred_at) <= $2::timestamptz
                     AND NOT lead_loss.lead_loss_active)
                 OR (d.decision='schedule' AND d.target_version=c.version AND NOT lead_loss.lead_loss_active
                     AND d.source_revision='message:' || coalesce(message_id,'none') || ':' ||
                         coalesce(last_status,'none') || ':' || coalesce(last_delivery_status,'none')))
             ORDER BY CASE WHEN last_direction='inbound' OR h.id IS NOT NULL
                        OR last_status IN ('queued','sending','failed','outcome_unknown')
                        OR last_delivery_status IN ('failed','outcome_unknown')
                        OR (d.decision IN ('schedule','snooze') AND d.target_version=c.version
                            AND d.remind_at <= $4::timestamptz
                            AND d.source_revision='message:' || coalesce(message_id,'none') || ':' ||
                                coalesce(last_status,'none') || ':' || coalesce(last_delivery_status,'none'))
                      THEN 0 ELSE 1 END,
                      coalesce(d.remind_at,h.created_at,last_occurred_at,c.opened_at),c.id
             LIMIT $3`,
            [
              actor.id,
              new Date(
                now.getTime() - DASHBOARD_FOLLOWUP_HOURS * 3_600_000,
              ).toISOString(),
              DASHBOARD_ACTION_LIMIT + 1,
              now.toISOString(),
            ],
          ),
          client.query(
            `SELECT o.id,o.number,o.version,o.status,o.conversation_id,o.final_amount_cents,
                    o.total_pieces,o.paid_on::text,o.delivered_on::text,o.finance_payment_review_required,
                    o.payment_condition,o.created_at,o.confirmed_at,contact.display_name,${DECISION_FIELDS}
             FROM crm.orders o LEFT JOIN crm.conversations c ON c.id=o.conversation_id
             LEFT JOIN crm.contact_identities identity ON identity.id=c.contact_identity_id
             LEFT JOIN crm.contacts contact ON contact.id=coalesce(o.contact_id,identity.current_contact_id)
             LEFT JOIN crm.dashboard_action_decisions d ON d.user_id=$1 AND d.action_id='order:' || o.id
             WHERE o.origin='atendimento' AND NOT o.is_test
               AND (o.manual_owner_id=$1 OR c.assigned_user_id=$1)
               AND (o.status='pendente' OR (o.status='confirmado' AND
                    (o.paid_on IS NULL OR o.finance_payment_review_required OR o.delivered_on IS NULL)))
             ORDER BY CASE WHEN o.status='confirmado' THEN 0 ELSE 1 END,o.created_at,o.id`,
            [actor.id],
          ),
        ]);
        // MET-08: an active declared loss removes the follow-up and the
        // reminders; send failures stay, they still need the send resolved.
        const items = conversations.rows
          .map((/** @type {any} */ row) => {
            const item = projectDashboardConversation(row, now);
            return row.lead_loss_active &&
              (item?.kind === 'followup' ||
                (item?.kind === 'reminder' &&
                  !String(item.reason).startsWith('send_')))
              ? null
              : item;
          })
          .filter(Boolean);
        for (const row of orders.rows) {
          const order = await loadOrder(client, row.id);
          if (!order) continue;
          const item = projectOrder(row, order, now);
          if (item) items.push(item);
        }
        const today = operationalDay(now);
        /** @param {any} item */
        const priority = (item) =>
          item.deferred
            ? 8
            : ['reply', 'handoff', 'reminder'].includes(item.kind)
              ? 0
              : item.order?.promisedDeliveryOn &&
                  item.order.promisedDeliveryOn < today
                ? 1
                : item.kind === 'pending_order'
                  ? 2
                  : item.kind === 'order_followup'
                    ? 3
                    : 4;
        items.sort(
          (/** @type {any} */ a, /** @type {any} */ b) =>
            priority(a) - priority(b) ||
            String(a.dueAt ?? a.attentionSince ?? '').localeCompare(
              String(b.dueAt ?? b.attentionSince ?? ''),
            ) ||
            a.id.localeCompare(b.id),
        );
        return {
          generatedAt: now.toISOString(),
          today,
          followupHours: DASHBOARD_FOLLOWUP_HOURS,
          items: items.slice(0, DASHBOARD_ACTION_LIMIT),
          hasMore:
            items.length > DASHBOARD_ACTION_LIMIT ||
            conversations.rows.length > DASHBOARD_ACTION_LIMIT ||
            orders.rows.length > DASHBOARD_ACTION_LIMIT,
        };
      });
    },
    /** @param {{actor:any,days?:number}} input */
    async performance(input) {
      const now = clock();
      const period = dashboardPeriod(now, input.days ?? 7);
      return database.transaction(async (/** @type {any} */ client) => {
        const actor = await lockActor(client, input.actor, false);
        const report = await readDashboardPerformance(client, {
          from: period.from,
          to: period.to,
          actorId: actor.id,
          manager: actor.capabilities.includes('COMMERCIAL_ADMIN'),
        });
        return { ...report, days: period.days, generatedAt: now.toISOString() };
      });
    },
    /** @param {{actor:any,actionId:string,decision:string,expectedVersion:number,sourceRevision:string,expectedDecisionVersion:number,remindAt?:unknown,idempotencyKey:string,correlationId:string}} input */
    async decide(input) {
      const actionId = identifier(input.actionId, 300);
      const match = /^(order|conversation):(.+)$/u.exec(actionId);
      if (!match) throw new DashboardError(400, 'INVALID_REQUEST');
      const targetType = match[1];
      const targetId = identifier(match[2]);
      const expectedVersion = version(input.expectedVersion);
      const expectedDecisionVersion = version(input.expectedDecisionVersion, 0);
      const expectedSource = identifier(input.sourceRevision, 600);
      if (!['snooze', 'resume', 'dismiss', 'schedule'].includes(input.decision))
        throw new DashboardError(400, 'INVALID_REQUEST');
      const now = clock();
      let remindAt = null;
      if (['snooze', 'schedule'].includes(input.decision)) {
        if (
          typeof input.remindAt !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:[0-5]\d)$/u.test(
            input.remindAt,
          ) ||
          Number.isNaN(Date.parse(input.remindAt)) ||
          new Date(`${input.remindAt.slice(0, 10)}T00:00:00Z`)
            .toISOString()
            .slice(0, 10) !== input.remindAt.slice(0, 10) ||
          Date.parse(input.remindAt) <= now.getTime() ||
          Date.parse(input.remindAt) > now.getTime() + 90 * 86_400_000
        ) {
          throw new DashboardError(422, 'INVALID_REMINDER_DATE');
        }
        remindAt = new Date(input.remindAt).toISOString();
      } else if (input.remindAt !== undefined)
        throw new DashboardError(400, 'INVALID_REQUEST');
      return database.transaction(async (/** @type {any} */ client) => {
        const actor = await lockActor(client, input.actor, true);
        // Same lock order as orders: conversation, then order. Never lock an
        // order before waiting for its conversation's ownership fence.
        let row;
        if (targetType === 'order') {
          const located = (
            await client.query(
              'SELECT conversation_id FROM crm.orders WHERE id=$1',
              [targetId],
            )
          ).rows[0];
          if (!located) throw new DashboardError(404, 'ACTION_NOT_FOUND');
          let conversation = null;
          if (located.conversation_id)
            conversation = (
              await client.query(
                'SELECT assigned_user_id FROM crm.conversations WHERE id=$1 FOR UPDATE',
                [located.conversation_id],
              )
            ).rows[0];
          row = (
            await client.query(
              'SELECT * FROM crm.orders WHERE id=$1 FOR UPDATE',
              [targetId],
            )
          ).rows[0];
          if (!row || row.conversation_id !== located.conversation_id)
            throw new DashboardError(409, 'VERSION_CONFLICT');
          const owner = row.conversation_id
            ? conversation?.assigned_user_id
            : row.manual_owner_id;
          if (owner !== actor.id) throw new DashboardError(403, 'FORBIDDEN');
        } else {
          row = (
            await client.query(
              `SELECT c.*,last_message.* FROM crm.conversations c ${LAST_MESSAGE_JOIN} WHERE c.id=$1 FOR UPDATE OF c`,
              [targetId],
            )
          ).rows[0];
          if (!row) throw new DashboardError(404, 'ACTION_NOT_FOUND');
          if (row.assigned_user_id !== actor.id)
            throw new DashboardError(403, 'FORBIDDEN');
        }
        const bound = {
          query: client.query.bind(client),
          transaction: async (/** @type {any} */ work) => work(client),
        };
        const idempotency = new PostgresIdempotencyRecordStore({
          database: bound,
          envelopeKey: options.idempotencyEnvelopeKey,
        });
        const command = {
          actionId,
          decision: input.decision,
          expectedVersion,
          sourceRevision: expectedSource,
          expectedDecisionVersion,
          remindAt,
        };
        return idempotency.execute(
          {
            scope: `dashboard.action.decide:${actor.id}`,
            key: identifier(input.idempotencyKey, 200),
            fingerprint: fingerprintCommand(command),
            actor: actor.id,
            action: 'dashboard.action.decide',
            target: { type: targetType, id: targetId },
            version: `${expectedVersion}:${expectedDecisionVersion}`,
            reason: `DASHBOARD_${input.decision.toUpperCase()}`,
            correlationId: input.correlationId,
          },
          async () => {
            const actualSource =
              targetType === 'order'
                ? `order:${row.version}`
                : sourceRevision(row);
            if (
              Number(row.version) !== expectedVersion ||
              actualSource !== expectedSource
            )
              throw new DashboardError(409, 'VERSION_CONFLICT');
            const eligible =
              targetType === 'order'
                ? row.origin === 'atendimento' &&
                  !row.is_test &&
                  (row.status === 'pendente' ||
                    (row.status === 'confirmado' &&
                      (!row.paid_on ||
                        row.finance_payment_review_required ||
                        !row.delivered_on)))
                : !row.archived_at &&
                  !row.terminal_at &&
                  row.automation_state === 'human' &&
                  !['encerrada', 'sem_lead', 'convertida_em_lead'].includes(
                    row.state,
                  );
            if (!eligible)
              throw new DashboardError(409, 'ACTION_NOT_AVAILABLE');
            const existing = (
              await client.query(
                'SELECT * FROM crm.dashboard_action_decisions WHERE user_id=$1 AND action_id=$2 FOR UPDATE',
                [actor.id, actionId],
              )
            ).rows[0];
            if (Number(existing?.version ?? 0) !== expectedDecisionVersion)
              throw new DashboardError(409, 'VERSION_CONFLICT');
            const candidate =
              targetType === 'conversation'
                ? projectDashboardConversation(
                    {
                      ...row,
                      decision_version: existing?.version,
                      decision_target_version: existing?.target_version,
                      decision_source_revision: existing?.source_revision,
                      decision_kind: existing?.decision,
                      decision_remind_at: existing?.remind_at,
                    },
                    now,
                  )
                : null;
            if (
              targetType === 'conversation' &&
              !candidate &&
              !['schedule', 'resume'].includes(input.decision)
            )
              throw new DashboardError(409, 'ACTION_NOT_AVAILABLE');
            if (input.decision === 'dismiss' && candidate?.kind !== 'followup')
              throw new DashboardError(409, 'ACTION_NOT_AVAILABLE');
            if (input.decision === 'schedule' && targetType !== 'conversation')
              throw new DashboardError(400, 'INVALID_REQUEST');
            if (input.decision === 'resume' && !existing)
              throw new DashboardError(409, 'ACTION_NOT_AVAILABLE');
            const saved = (
              await client.query(
                `INSERT INTO crm.dashboard_action_decisions
               (user_id,action_id,target_type,target_id,target_version,source_revision,decision,remind_at,version,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$9)
             ON CONFLICT (user_id,action_id) DO UPDATE SET target_version=EXCLUDED.target_version,
               source_revision=EXCLUDED.source_revision,decision=EXCLUDED.decision,remind_at=EXCLUDED.remind_at,
               version=dashboard_action_decisions.version+1,updated_at=EXCLUDED.updated_at
             RETURNING version,remind_at`,
                [
                  actor.id,
                  actionId,
                  targetType,
                  targetId,
                  expectedVersion,
                  expectedSource,
                  input.decision,
                  remindAt,
                  now.toISOString(),
                ],
              )
            ).rows[0];
            const decisionVersion = Number(saved.version);
            await new PostgresAuditTrail(client).append({
              actor: actor.id,
              action: 'dashboard.action.decided',
              target: { type: targetType, id: targetId },
              version: decisionVersion,
              reason: `DASHBOARD_${input.decision.toUpperCase()}`,
              correlationId: input.correlationId,
            });
            return {
              id: actionId,
              decision: input.decision,
              decisionVersion,
              remindAt: iso(saved.remind_at),
            };
          },
        );
      });
    },
  });
}

/** @param {string|undefined} value @param {string} name */
function key(value, name) {
  const decoded = Buffer.from(value ?? '', 'base64');
  if (decoded.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return decoded;
}

/** @param {any} database @param {{access:any,environment?:Record<string,string|undefined>,clock?:()=>Date}} options */
export function createDashboardApiRuntime(database, options) {
  const environment = options.environment ?? process.env;
  return createDashboardRuntime(database, {
    access: options.access,
    clock: options.clock,
    orderEnvelopeKey: key(
      environment.N8N_INTEGRATION_ENVELOPE_KEY,
      'N8N_INTEGRATION_ENVELOPE_KEY',
    ),
    idempotencyEnvelopeKey: key(
      environment.IDEMPOTENCY_ENVELOPE_KEY,
      'IDEMPOTENCY_ENVELOPE_KEY',
    ),
  });
}
