/** RFC 052 / INBOX-VEZ-01: the definition of an active lead loss now lives with
 * the Inbox turn policy (modules must not import from apps/). Re-exported here
 * for the lead-outcome command, the action queue and the metrics.
 */
export { activeLeadLossSql } from '@crm-silmer/inbox-channels';

/** PERF-03 / MET-02: an effective human send (sent, not failed or unknown).
 * @param {string} m message alias */
export const EFFECTIVE_HUMAN_SEND = (m) =>
  `${m}.direction = 'outbound' AND ${m}.author_kind = 'human' AND ${m}.status = 'sent'
   AND coalesce(${m}.delivery_status,'sent') NOT IN ('failed','outcome_unknown')`;
