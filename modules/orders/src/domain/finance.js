/** Financeiro is an operational check, independent of the commercial status. */
export class FinanceError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'FinanceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** @param {unknown} value */
export function financeQuery(value = {}) {
  const query = /** @type {Record<string, unknown>} */ (value);
  if (
    !query ||
    typeof query !== 'object' ||
    Array.isArray(query) ||
    Object.keys(query).some(
      (key) => !['status', 'limit', 'cursor'].includes(key),
    )
  ) {
    throw new FinanceError(400, 'INVALID_FILTER');
  }
  const status = query.status ?? 'waiting';
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (
    typeof status !== 'string' ||
    !['waiting', 'completed'].includes(status) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new FinanceError(400, 'INVALID_FILTER');
  }
  /** @type {{at:string, sequence:number, id:string}|null} */
  let after = null;
  if (query.cursor !== undefined && query.cursor !== null) {
    try {
      if (
        typeof query.cursor !== 'string' ||
        query.cursor.length > 1024 ||
        !/^[\w-]+$/u.test(query.cursor)
      )
        throw new Error();
      const parsed = JSON.parse(
        Buffer.from(query.cursor, 'base64url').toString('utf8'),
      );
      if (
        parsed.status !== status ||
        typeof parsed.at !== 'string' ||
        !Number.isFinite(Date.parse(parsed.at)) ||
        !Number.isSafeInteger(parsed.sequence) ||
        parsed.sequence < 1 ||
        typeof parsed.id !== 'string' ||
        !parsed.id ||
        parsed.id.length > 255 ||
        (status === 'waiting' && !/^\d{4}-\d{2}-\d{2}$/u.test(parsed.at))
      )
        throw new Error();
      after = { at: parsed.at, sequence: parsed.sequence, id: parsed.id };
    } catch {
      throw new FinanceError(400, 'INVALID_CURSOR');
    }
  }
  return {
    status: /** @type {'waiting'|'completed'} */ (status),
    limit,
    after,
  };
}

/** @param {any} row @param {'waiting'|'completed'} status */
export function financeCursor(row, status) {
  return Buffer.from(
    JSON.stringify({
      status,
      at:
        status === 'waiting'
          ? row.paid_on
          : new Date(row.completed_at).toISOString(),
      sequence: Number(row.number_sequence),
      id: row.id,
    }),
  ).toString('base64url');
}

/** @param {any} row */
export function isFinanceEligible(row) {
  return (
    row?.status === 'confirmado' &&
    Boolean(row.paid_on) &&
    row.is_test === false &&
    row.finance_payment_review_required === false &&
    Number.isSafeInteger(Number(row.final_amount_cents)) &&
    Number(row.final_amount_cents) > 0 &&
    (row.origin !== 'loja' ||
      Number(row.paid_amount_cents) >= Number(row.final_amount_cents))
  );
}

/** @param {any} input */
export function financeVersions(input) {
  if (
    !input ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !Number.isSafeInteger(input.expectedFinanceVersion) ||
    input.expectedFinanceVersion < 0
  ) {
    throw new FinanceError(400, 'INVALID_EXPECTED_VERSION');
  }
  return {
    expectedVersion: input.expectedVersion,
    expectedFinanceVersion: input.expectedFinanceVersion,
  };
}
