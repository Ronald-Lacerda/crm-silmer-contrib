import { isDeepStrictEqual } from 'node:util';
import { OrderConflictError } from '../domain/errors.js';
import { normalizeFicha } from '../domain/ficha.js';

// Callers hold the order row before reading this ledger. Export acceptance,
// cancellation and every commercial writer serialize on that same row.
const LOCKED = `export.state NOT IN ('invalidated','rejected') OR
  export.remote_id IS NOT NULL OR export.observed_sale_id IS NOT NULL OR
  EXISTS (SELECT 1 FROM crm.olist_attempts attempt
    WHERE attempt.export_id=export.id AND attempt.outcome<>'rejected') OR
  EXISTS (SELECT 1 FROM crm.olist_export_resources dependency
    JOIN crm.olist_attempts attempt ON attempt.resource_id=dependency.resource_id
    WHERE dependency.export_id=export.id AND attempt.outcome<>'rejected')`;

/** @param {any} tx @param {string[]} orderIds @returns {Promise<{order_id:string,state:string}[]>} */
export async function readOlistCommercialLocks(tx, orderIds) {
  if (!orderIds.length) return [];
  return (
    await tx.query(
      `SELECT export.order_id,export.state FROM crm.olist_exports export
     WHERE export.order_id=ANY($1::text[]) AND (${LOCKED})`,
      [orderIds],
    )
  ).rows;
}

/** A completed export allows only the pending -> confirmed transition with
 * identical content. Milestones are independent and remain authorized by Orders.
 * @param {any} tx @param {any} current @param {any} candidate @param {string} eventType */
export async function assertOlistCommercialWrite(
  tx,
  current,
  candidate,
  eventType,
) {
  const locks = await readOlistCommercialLocks(tx, [current.id]);
  if (!locks.length || eventType === 'order.milestones_saved') return false;
  if (
    eventType !== 'order.confirmed' ||
    current.status !== 'pendente' ||
    candidate?.status !== 'confirmado' ||
    locks.some(
      (/** @type {any} */ row) => !['confirmed', 'linked'].includes(row.state),
    )
  ) {
    throw new OrderConflictError(
      'The Olist commercial snapshot is locked',
      'ORDER_OLIST_LOCKED',
    );
  }
  if (
    candidate.finalAmountCents !== current.finalAmountCents ||
    candidate.paymentCondition !== current.paymentCondition ||
    candidate.totalPieces !== current.totalPieces ||
    !isDeepStrictEqual(
      normalizeFicha(candidate.ficha),
      normalizeFicha(current.ficha),
    )
  ) {
    throw new OrderConflictError(
      'Confirmation must preserve the exported content',
      'ORDER_OLIST_SNAPSHOT_MISMATCH',
    );
  }
  return true;
}
