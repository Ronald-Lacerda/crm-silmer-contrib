import { randomUUID } from 'node:crypto';
import { decryptJson } from './envelope.js';
import {
  FinanceError,
  financeCursor,
  isFinanceEligible,
} from '../domain/finance.js';

const ELIGIBLE = `o.status = 'confirmado' AND o.paid_on IS NOT NULL
  AND NOT o.is_test AND NOT o.finance_payment_review_required
  AND o.final_amount_cents > 0
  AND (o.origin <> 'loja' OR o.paid_amount_cents >= o.final_amount_cents)`;
const SELECT = `SELECT o.id, o.number, o.number_sequence, o.origin, o.status, o.manual_owner_id,
  o.paid_on::text AS paid_on, o.final_amount_cents, o.paid_amount_cents,
  o.finance_payment_review_required, o.is_test, o.total_pieces, o.version,
  o.ficha_envelope, coalesce(f.version, 0) AS finance_version,
  f.completed_at, finisher.name AS completed_by_name,
  owner.name AS owner_name
 FROM crm.orders o
 LEFT JOIN crm.order_finance f ON f.order_id = o.id
 LEFT JOIN crm.users finisher ON finisher.id = f.completed_by
 LEFT JOIN crm.conversations c ON c.id = o.conversation_id
 LEFT JOIN crm.users owner ON owner.id = coalesce(o.manual_owner_id, c.assigned_user_id)`;

/** The caller owns the transaction, including idempotency and audit. */
export class PostgresFinanceRepository {
  /** @param {{envelopeKey:Buffer}} options */
  constructor({ envelopeKey }) {
    this.envelopeKey = envelopeKey;
  }

  /** @param {any} client @param {ReturnType<typeof import('../domain/finance.js').financeQuery>} filters */
  async list(client, filters) {
    const counted = await client.query(`SELECT
      count(*) FILTER (WHERE f.completed_at IS NULL)::integer AS waiting,
      count(*) FILTER (WHERE f.completed_at IS NOT NULL)::integer AS completed
      FROM crm.orders o LEFT JOIN crm.order_finance f ON f.order_id = o.id
      WHERE ${ELIGIBLE}`);
    const completed = filters.status === 'completed';
    const order = completed
      ? 'f.completed_at DESC, o.number_sequence ASC, o.id ASC'
      : 'o.paid_on ASC, o.number_sequence ASC, o.id ASC';
    const values = [];
    let cursor = '';
    if (filters.after) {
      values.push(filters.after.at, filters.after.sequence, filters.after.id);
      cursor = completed
        ? `AND (f.completed_at < $1::timestamptz OR
            (f.completed_at = $1::timestamptz AND (o.number_sequence, o.id) > ($2::bigint, $3::text)))`
        : `AND (o.paid_on, o.number_sequence, o.id) > ($1::date, $2::bigint, $3::text)`;
    }
    values.push(filters.limit + 1);
    const page = await client.query(
      `${SELECT} WHERE ${ELIGIBLE}
      AND f.completed_at IS ${completed ? 'NOT ' : ''}NULL ${cursor}
      ORDER BY ${order} LIMIT $${values.length}`,
      values,
    );
    const rows = page.rows.slice(0, filters.limit);
    return {
      items: rows.map((/** @type {any} */ row) => this.present(row)),
      counts: counted.rows[0],
      nextCursor:
        page.rows.length > filters.limit
          ? financeCursor(rows.at(-1), filters.status)
          : null,
    };
  }

  /** @param {any} client @param {string} id @param {boolean} [lock] */
  async find(client, id, lock = false) {
    // Lock the order before its financial state: commercial writes use the same row.
    if (lock)
      await client.query('SELECT id FROM crm.orders WHERE id = $1 FOR UPDATE', [
        id,
      ]);
    const { rows } = await client.query(`${SELECT} WHERE o.id = $1`, [id]);
    const row = rows[0];
    if (!isFinanceEligible(row))
      throw new FinanceError(404, 'FINANCE_ORDER_NOT_FOUND');
    return row;
  }

  /** @param {any} client @param {any} row @param {boolean} canManage */
  async detail(client, row, canManage) {
    const ficha = this.ficha(row);
    const { rows } = await client.query(
      `SELECT e.id, e.action, e.reason,
      e.occurred_at, actor.name AS actor_name
      FROM crm.order_finance_events e LEFT JOIN crm.users actor ON actor.id = e.actor_id
      WHERE e.order_id = $1 ORDER BY e.version DESC`,
      [row.id],
    );
    return {
      ...this.present(row),
      canManage,
      items: (ficha.items ?? []).map((/** @type {any} */ item) => ({
        tipo: item.tipo,
        cor: item.cor,
        grade: item.grade,
        malhas: item.malhas,
        tipo_servico: item.tipo_servico,
        gola: item.gola,
        publico: item.publico,
      })),
      history: rows.map((/** @type {any} */ event) => ({
        id: event.id,
        action: event.action,
        reason: event.reason,
        actorName: event.actor_name ?? 'Sistema',
        occurredAt: new Date(event.occurred_at).toISOString(),
      })),
    };
  }

  /** @param {any} row */
  ficha(row) {
    return decryptJson(
      row.ficha_envelope,
      `order-ficha:${row.id}`,
      this.envelopeKey,
    );
  }

  /** @param {any} row */
  present(row) {
    const ficha = this.ficha(row);
    return {
      id: row.id,
      number: row.number,
      clientName: ficha.summary?.cliente ?? '',
      origin: row.origin,
      isManual: row.origin !== 'loja' && Boolean(row.manual_owner_id),
      ownerName:
        row.origin === 'loja'
          ? 'Loja do site'
          : (row.owner_name ?? 'Sem responsável'),
      totalPieces: Number(row.total_pieces),
      finalAmountCents: Number(row.final_amount_cents),
      paidOn: row.paid_on,
      deliveryOn: ficha.summary?.data_entrega_confirmada ?? null,
      version: Number(row.version),
      financeVersion: Number(row.finance_version),
      completedAt: row.completed_at
        ? new Date(row.completed_at).toISOString()
        : null,
      completedByName: row.completed_by_name ?? null,
    };
  }

  /** @param {any} client @param {{row:any, action:'completed'|'reopened', actorId:string, correlationId:string, now:Date}} input */
  async change(client, input) {
    const { row, action, actorId, correlationId, now } = input;
    const completed = action === 'completed';
    if (Boolean(row.completed_at) === completed)
      throw new FinanceError(409, 'FINANCE_STATUS_CONFLICT');
    await client.query(
      `INSERT INTO crm.order_finance (order_id) VALUES ($1)
      ON CONFLICT (order_id) DO NOTHING`,
      [row.id],
    );
    const { rows } = await client.query(
      `UPDATE crm.order_finance SET version = version + 1,
      completed_at = $2, completed_by = $3, updated_at = $4 WHERE order_id = $1 RETURNING version`,
      [
        row.id,
        completed ? now.toISOString() : null,
        completed ? actorId : null,
        now.toISOString(),
      ],
    );
    await client.query(
      `INSERT INTO crm.order_finance_events
      (id, order_id, version, order_version, action, actor_id, reason, occurred_at, correlation_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        row.id,
        Number(rows[0].version),
        Number(row.version),
        action,
        actorId,
        completed ? 'FINANCE_ROUTINE_COMPLETED' : 'FINANCE_ROUTINE_REOPENED',
        now.toISOString(),
        correlationId,
      ],
    );
    return this.find(client, row.id);
  }
}
