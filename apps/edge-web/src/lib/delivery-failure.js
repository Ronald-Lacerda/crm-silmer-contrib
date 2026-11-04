/**
 * INBOX-DELIVERY-01/02 (RFC 041): the technical code of a failed or
 * uncertain send, for whoever reports it to support, with one sentence in
 * plain words when this build knows the code. Human messages carry the code
 * of the n8n command; the agent's messages, the code n8n reports in
 * `message.failed` / `message.send.unknown` (`SEND_FAILED`,
 * `SEND_OUTCOME_UNKNOWN` when it reports none). The code itself is only
 * shown when it has the shape the database accepts.
 */

const CODE = /^[A-Z0-9_]{1,64}$/u;

const REFUSED = 'A automação de envio recusou a mensagem.';
const NOT_FOUND = 'A automação de envio não foi encontrada.';
const CREDENTIALS = 'A automação de envio recusou o acesso do CRM.';
const UNCONFIRMED =
  'O serviço de mensagens não confirmou se a mensagem chegou ao cliente.';

const HINTS = Object.freeze({
  COMMAND_LEASE_EXPIRED: 'O envio demorou demais e foi interrompido.',
  EVOLUTION_RECIPIENT_NOT_FOUND:
    'O WhatsApp não reconheceu o número informado na verificação.',
  EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE:
    'A verificação do número no WhatsApp não pôde ser concluída.',
  N8N_COMMAND_ACK_MISMATCH: REFUSED,
  N8N_COMMAND_DELIVERY_FAILED: 'A automação de envio informou uma falha.',
  N8N_COMMAND_HTTP_401: CREDENTIALS,
  N8N_COMMAND_HTTP_403: CREDENTIALS,
  N8N_COMMAND_HTTP_404: NOT_FOUND,
  N8N_COMMAND_HTTP_405: NOT_FOUND,
  N8N_COMMAND_ID_MISMATCH: REFUSED,
  N8N_COMMAND_INVALID: REFUSED,
  N8N_COMMAND_NETWORK_ERROR:
    'A conexão com a automação de envio caiu antes da resposta.',
  N8N_COMMAND_NOT_FOUND: NOT_FOUND,
  N8N_COMMAND_PAYLOAD_CHANGED: REFUSED,
  N8N_COMMAND_PAYLOAD_INVALID: REFUSED,
  N8N_COMMAND_RECONCILED_FAILED:
    'A conferência com a automação de envio encontrou uma falha.',
  N8N_COMMAND_REJECTED: REFUSED,
  N8N_COMMAND_REMOTE_UNAVAILABLE: 'A automação de envio estava fora do ar.',
  N8N_COMMAND_STALE:
    'A mensagem ficou desatualizada antes do envio e não foi enviada.',
  N8N_COMMAND_TIMEOUT: 'A automação de envio demorou demais para responder.',
  META_SEND_OUTCOME_UNKNOWN: UNCONFIRMED,
  OUTCOME_UNKNOWN: UNCONFIRMED,
  SEND_FAILED: 'O serviço de mensagens não entregou a mensagem ao cliente.',
  SEND_OUTCOME_UNKNOWN: UNCONFIRMED,
});

/** The code to show, or null outside the accepted shape. @param {unknown} code */
export function deliveryFailureCode(code) {
  return typeof code === 'string' && CODE.test(code) ? code : null;
}

/** One sentence for a known code; '' for any other. @param {unknown} code */
export function deliveryFailureHint(code) {
  const valid = deliveryFailureCode(code);
  return valid && Object.hasOwn(HINTS, valid)
    ? HINTS[/** @type {keyof typeof HINTS} */ (valid)]
    : '';
}
