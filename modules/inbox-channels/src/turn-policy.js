/**
 * RFC 052 / INBOX-VEZ-01: the thresholds and the shared SQL fragment of the
 * Inbox "whose turn is it" reading. One source for each; the Central de acoes
 * and the dashboard import them from here.
 */

/** A customer's turn is "sem retorno" after this long (ACT-06, inclusive). */
export const SILENT_AFTER_HOURS = 72;

export const INBOX_BUCKETS = Object.freeze([
  'respond',
  'awaiting',
  'silent',
  'lost',
]);

/** RFC 048 / ADR 061 (MET-07): the single definition of an active lead loss,
 * shared by the lead-outcome command, the action queue, the metrics and the
 * Inbox tabs. It is derived from the messages, never written by the inbound
 * path: the latest outcome event is `lost` and the conversation's last
 * customer message is still the one the loss was declared over.
 *
 * The argument must be a trusted SQL column reference, never user input.
 * @param {string} conversationColumn
 */
export function activeLeadLossSql(conversationColumn) {
  return `EXISTS (
    SELECT 1 FROM (
      SELECT latest.outcome, latest.last_inbound_message_id
      FROM crm.lead_outcome_events latest
      WHERE latest.conversation_id = ${conversationColumn}
      ORDER BY latest.version DESC LIMIT 1
    ) lead_outcome
    WHERE lead_outcome.outcome = 'lost'
      AND lead_outcome.last_inbound_message_id IS NOT DISTINCT FROM (
        SELECT customer.id FROM crm.messages customer
        WHERE customer.conversation_id = ${conversationColumn}
          AND customer.direction = 'inbound' AND customer.author_kind = 'contact'
        ORDER BY customer.occurred_at DESC, customer.id DESC LIMIT 1
      )
  )`;
}
