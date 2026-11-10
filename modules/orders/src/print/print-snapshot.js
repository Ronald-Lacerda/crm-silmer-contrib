import { blankProduction } from './ficha-canonical-v2.js';
import { PRODUCTION_FIELDS_V8 } from './ficha-canonical-v8.js';
import { factoryContent } from './ficha-v8-content.js';

export const TEMPLATE_V2 = 'ficha-canonical-v2';
export const TEMPLATE_V3 = 'ficha-canonical-v3';
export const TEMPLATE_V4 = 'ficha-canonical-v4';
export const TEMPLATE_V5 = 'ficha-canonical-v5';
export const TEMPLATE_V6 = 'ficha-canonical-v6';
export const TEMPLATE_V7 = 'ficha-canonical-v7';
export const TEMPLATE_V8 = 'ficha-canonical-v8';

/** A field nobody filled prints blank, never "null". @param {unknown} value */
function printedText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * The order date and the other days of the order are stored as ISO days;
 * the paper shows them the way the shop floor reads them (dd/mm/aaaa, as in
 * the approved sample). Older free text prints as it was typed.
 *
 * @param {unknown} value
 */
function printedDate(value) {
  const text = printedText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  return match ? match[3] + '/' + match[2] + '/' + match[1] : text;
}

// D00.6-05: an instant prints as its São Paulo day.
const OPERATIONAL_DAY = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
});

/** @param {unknown} value */
function printedInstantDay(value) {
  if (typeof value !== 'string' || value === '') return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : OPERATIONAL_DAY.format(date);
}

/**
 * PLA-08 (ADR 008, ADR 017): the days of the trail that the summary does not
 * already print. The order date and the promised delivery stay only in the
 * summary, so page 1 shows each of the five days once. A day nobody recorded
 * yet is ''.
 *
 * @param {any} order
 */
function printedTrail(order) {
  return {
    primeiro_contato: printedInstantDay(order.firstContactAt),
    pagamento: printedDate(order.paidOn),
    entrega_realizada: printedDate(order.deliveredOn),
  };
}

/**
 * The printed snapshot built from an order in the public Order contract
 * (D10). `vendedor` is whoever confirmed it and `data` is the order date:
 * both are frozen at confirmation, so passing the conversation on afterwards
 * never rewrites the paper. The final amount and the payment condition stay
 * out of the document (D12), and the production block reaches the shop floor
 * blank.
 *
 * The v2 snapshot is exactly the one the print route built before ADR 017;
 * v3 adds the date trail, and v4 to v7 who makes the art. Items travel as
 * stored (v6 prints their audience, v7 renames two labels): each template
 * decides how to print them.
 *
 * v8 (ADR 078) prints the allowlisted factory instructions, omits the payment
 * day and carries only the seven production fields left on the sheet.
 *
 * @param {any} order
 * @param {string} [templateVersion]
 */
export function printSnapshot(order, templateVersion = TEMPLATE_V2) {
  if (
    templateVersion !== TEMPLATE_V2 &&
    templateVersion !== TEMPLATE_V3 &&
    templateVersion !== TEMPLATE_V4 &&
    templateVersion !== TEMPLATE_V5 &&
    templateVersion !== TEMPLATE_V6 &&
    templateVersion !== TEMPLATE_V7 &&
    templateVersion !== TEMPLATE_V8
  ) {
    throw new Error(`Unknown ficha template: ${templateVersion}`);
  }
  const { items, observations, summary } = order.ficha;
  /** @type {Record<string, unknown>} */
  const pedido = {
    aplicacao: printedText(summary.aplicacao),
    cliente: printedText(summary.cliente),
    data: printedDate(order.orderDate),
    data_entrega_confirmada: printedDate(summary.data_entrega_confirmada),
    fab: printedText(order.fabCode),
    itens: items,
    nome: printedText(summary.nome),
    numero: printedText(order.number),
    observacoes:
      templateVersion === TEMPLATE_V8
        ? factoryContent(order.ficha)
        : observations,
    quantidade_total: order.totalPieces,
    vendedor: printedText(order.confirmedBy?.name),
  };
  if (templateVersion !== TEMPLATE_V2) {
    const trail = printedTrail(order);
    pedido.lastro =
      templateVersion === TEMPLATE_V8
        ? {
            primeiro_contato: trail.primeiro_contato,
            entrega_realizada: trail.entrega_realizada,
          }
        : trail;
  }
  if (
    templateVersion === TEMPLATE_V4 ||
    templateVersion === TEMPLATE_V5 ||
    templateVersion === TEMPLATE_V6 ||
    templateVersion === TEMPLATE_V7 ||
    templateVersion === TEMPLATE_V8
  ) {
    pedido.artwork = order.ficha.artwork ?? {
      feito_pelo_cliente: false,
      feito_pela_silmer: false,
      files: [],
    };
  }
  if (templateVersion === TEMPLATE_V8) {
    pedido.versao = order.version;
    const blank = /** @type {Record<string, string>} */ (blankProduction());
    return {
      pedido,
      producao: Object.fromEntries(
        PRODUCTION_FIELDS_V8.map((field) => [field, blank[field]]),
      ),
    };
  }
  return { pedido, producao: blankProduction() };
}
