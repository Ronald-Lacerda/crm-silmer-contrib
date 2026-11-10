import { OrderValidationError } from '../domain/errors.js';

// FIP-02: explicit production/logistics fields only. Never serialize the
// briefing wholesale: billing, fiscal data and future integrations live there too.
const FIELDS = Object.freeze([
  ['notes', 'Notas do atendimento'],
  ['product_model', 'Modelo informado no atendimento'],
  ['customizations', 'Personalizações'],
  ['numbers', 'Numeração'],
  ['sponsors', 'Patrocinadores'],
  ['artwork_locations', 'Locais de aplicação da arte'],
  ['delivery_mode', 'Modalidade de entrega'],
  ['delivery_address', 'Endereço de entrega'],
  ['city_or_postal_code', 'Cidade / CEP'],
  ['pickup_location', 'Local de retirada'],
  ['needed_by', 'Data desejada pelo cliente (não é previsão confirmada)'],
]);

/** @param {unknown} value @returns {string[]} */
function texts(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** @param {any} ficha */
export function factoryInstructions(ficha) {
  const observations = texts(ficha?.observations);
  const complementary = FIELDS.flatMap(([key, label]) =>
    texts(ficha?.serviceData?.[key]).map(
      (value) => `${label} — informação complementar do atendimento: ${value}`,
    ),
  );
  return [...observations, ...complementary];
}

/**
 * A detected financial instruction must be reviewed in the CRM, never
 * silently erased from the customer's production instructions. This is a
 * conservative guard for explicit currency/payment text, not semantic NLP.
 *
 * @param {unknown} value
 */
export function assertFactoryText(value) {
  const text = typeof value === 'string' ? value : '';
  if (
    /(?:R\s*\$|US\s*\$|€|\b\d[\d.,]*\s*(?:reais|real|centavos?|d[oó]lares?)\b|\b(?:pix|pagamento|cobran[çc]a|parcelas?|parcelamento|comprovante|saldo\s+devedor|valor\s+(?:pago|total|unit[aá]rio))\b)/iu.test(
      text,
    )
  ) {
    throw new OrderValidationError(
      'Revise o conteúdo financeiro nos textos da ficha antes de imprimir.',
      'PRINT_FINANCIAL_TEXT_REVIEW_REQUIRED',
      ['ficha'],
    );
  }
}
