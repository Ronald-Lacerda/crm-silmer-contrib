/**
 * INBOX-HANDOFF-02 (RFC 041): what the agent leaves for the person who takes
 * the conversation. Two readings:
 *
 * - the seller the customer asked for, by first name only (the handoff keeps
 *   no owner; RULES.md: any seller may claim it);
 * - on a direct takeover (no handoff), the agent's last turn: the point it was
 *   asking, the ficha progress and how many of its messages it used.
 *
 * Codes and counts only; a code this build does not know is left out instead
 * of reaching the screen as an identifier.
 */
import { brand } from '../brand/index.js';

/**
 * The points the agent may ask (`asked_field`, ADR 012 / ADR 024), in the
 * words of the Ficha. They mirror `FICHA_POINT_LABELS` of the workflow SDK
 * (ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sdk.js), plus the fields the
 * output parser still accepts from older versions.
 */
export const ASKED_FIELD_LABELS = Object.freeze({
  artwork_locations: 'Onde vai a estampa',
  artwork_status: 'Arte',
  artwork_technique: 'Técnica',
  city_or_postal_code: 'Cidade ou CEP',
  collar: 'Gola',
  colors: 'Cor',
  customer_name: 'Nome do cliente',
  delivery_address: 'Endereço de entrega',
  delivery_mode: 'Entrega ou retirada',
  fabrics: 'Tecido',
  needed_by: 'Para quando',
  order_intent: 'Se quer fazer um pedido',
  pickup_location: 'Local de retirada',
  product_model: 'Modelo',
  product_type: 'Produto',
  purchase_profile: 'Perfil de compra',
  purpose: 'Finalidade',
  quantity: 'Quantidade',
  sizes: 'Tamanhos',
});

/**
 * The contract (RFC 041) names the fields in snake_case and the Inbox read
 * model in camelCase; both spellings of an answer read the same.
 *
 * @param {unknown} value
 * @returns {any}
 */
export function snakeKeys(value) {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
      snakeKeys(item),
    ]),
  );
}

/** @param {unknown} code */
export function askedFieldLabel(code) {
  return typeof code === 'string' && Object.hasOwn(ASKED_FIELD_LABELS, code)
    ? ASKED_FIELD_LABELS[/** @type {keyof typeof ASKED_FIELD_LABELS} */ (code)]
    : '';
}

/** @param {unknown} value */
function firstName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim().split(/\s+/u)[0] ?? '';
  // A first name, never a sentence: control characters or a long text
  // (a server bug) are dropped instead of shown.
  return name.length <= 40 && !/[\p{Cc}<>]/u.test(name) ? name : '';
}

/**
 * The only place that reads who the customer asked for. It takes the Inbox
 * list item's handoff (`preferredSellerFirstName`) and the handoff read
 * (`preferredSeller.firstName`); the snake_case names of the contract
 * (`handoff_preferred_seller_first_name`, `preferred_seller.first_name`) are
 * read too, so a rename on the API side changes this function only.
 *
 * @param {Record<string, any>|null|undefined} source
 */
export function preferredSellerFirstName(source) {
  if (!source || typeof source !== 'object') return '';
  return firstName(
    source.preferredSellerFirstName ??
      source.preferredSeller?.firstName ??
      source.handoff_preferred_seller_first_name ??
      source.preferred_seller?.first_name ??
      source.handoffPreferredSellerFirstName,
  );
}

/** "Cliente pediu: Ana", or '' when nobody was asked for. @param {unknown} name */
export function preferredSellerLabel(name) {
  return typeof name === 'string' && name ? `Cliente pediu: ${name}` : '';
}

/** @param {unknown} value */
function count(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** "O agente", from the brand. */
function assistantSubject() {
  const reference = brand.assistant.reference;
  return reference.charAt(0).toLocaleUpperCase('pt-BR') + reference.slice(1);
}

/** "do agente", from the brand. */
function ofAssistant() {
  const match = /^(o|a|os|as)\s+(.+)$/iu.exec(brand.assistant.reference);
  return match
    ? `d${match[1].toLowerCase()} ${match[2]}`
    : `de ${brand.assistant.reference}`;
}

/**
 * The lines of a direct takeover, from
 * `GET /api/v1/inbox/conversations/:id/assistant-context`:
 * "O agente estava perguntando: Cor · Ficha 3 de 8" and
 * "4 de 15 mensagens do agente". Each line is left out when its data is.
 *
 * @param {Record<string, any>|null|undefined} answer
 * @returns {string[]}
 */
export function assistantContextLines(answer) {
  if (!answer || typeof answer !== 'object') return [];
  const context = snakeKeys(answer);
  const turn =
    context.last_turn && typeof context.last_turn === 'object'
      ? context.last_turn
      : null;
  const lines = [];
  const field = askedFieldLabel(turn?.asked_field);
  const filled = count(turn?.ficha_filled);
  const total = count(turn?.ficha_total);
  const ficha =
    filled !== null && total && filled <= total
      ? `Ficha ${filled} de ${total}`
      : '';
  if (field) {
    lines.push(
      `${assistantSubject()} estava perguntando: ${field}${ficha ? ` · ${ficha}` : ''}`,
    );
  } else if (ficha) {
    lines.push(ficha);
  }
  const used = count(context.assistant_messages);
  const cap = count(context.assistant_message_cap);
  if (used !== null && cap) {
    lines.push(`${used} de ${cap} mensagens ${ofAssistant()}`);
  }
  return lines;
}
