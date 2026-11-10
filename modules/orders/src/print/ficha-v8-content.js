import { OrderValidationError } from '../domain/errors.js';
import { factoryInstructions } from './factory-instructions.js';

// FPI-10 (ADR 078): what the factory reads, by where the text comes from. Only
// `ficha.observations` can be edited by a person, so only they can stop the
// paper. Customer and item fields never block, and a bot's complementary line
// with money in it prints its label and sends the reader back to the CRM.
const COMPLEMENTARY_MARK = ' — informação complementar do atendimento: ';

const FINANCIAL =
  /(?:R\s*\$|US\s*\$|€|\b\d[\d.,]*\s*(?:reais|real|centavos?|d[oó]lares?)\b|\b(?:pix|pagamentos?|pagos?|cobran[çc]as?|parcelas?|parcelamento|parcelad[oa]s?|boletos?|comprovantes?|nsu|saldo\s+devedor|valor\s+(?:pago|total|unit[aá]rio))\b)/iu;

/** @param {string} text */
export function hasFinancialText(text) {
  return FINANCIAL.test(text);
}

/**
 * The factory lines for the v8 sheet. Throws 422 when an editable observation
 * names money, judged on the whole text before any note is split for paper.
 *
 * @param {any} ficha
 * @returns {string[]}
 */
export function factoryContent(ficha) {
  const observations = factoryInstructions({
    observations: ficha?.observations,
  });
  if (observations.some(hasFinancialText)) {
    throw new OrderValidationError(
      'Revise o conteúdo financeiro nos textos da ficha antes de imprimir.',
      'PRINT_FINANCIAL_TEXT_REVIEW_REQUIRED',
      ['ficha'],
    );
  }
  const complementary = factoryInstructions({
    serviceData: ficha?.serviceData,
  }).map((line) => {
    const at = line.indexOf(COMPLEMENTARY_MARK);
    const label = at < 0 ? line : line.slice(0, at);
    const value = at < 0 ? line : line.slice(at + COMPLEMENTARY_MARK.length);
    return hasFinancialText(value)
      ? `${label} — contém informação financeira; conferir no CRM`
      : line;
  });
  return [...observations, ...complementary];
}
