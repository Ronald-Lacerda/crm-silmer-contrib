export class BillingError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'BillingError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** @param {unknown} value */
export function billingPercent(value) {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100)
    throw new BillingError(400, 'BILLING_INVALID_PERCENT');
  return Number(value);
}

/** @param {number} total @param {number} percent */
export function billingSplit(total, percent) {
  billingPercent(percent);
  if (!Number.isSafeInteger(total) || total < 100)
    throw new BillingError(422, 'BILLING_INVALID_AMOUNT');
  const signal = Number((BigInt(total) * BigInt(percent) + 50n) / 100n);
  const balance = total - signal;
  if ((signal > 0 && signal < 100) || (balance > 0 && balance < 100))
    throw new BillingError(422, 'BILLING_MINIMUM_AMOUNT');
  return { signalAmountCents: signal, balanceAmountCents: balance };
}

/** @param {unknown} value @param {boolean} [nullable] */
export function billingUrl(value, nullable = false) {
  if ((value === null || value === undefined) && nullable) return null;
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error();
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !['infinitepay.io', 'infinitepay.com.br'].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    )
      throw new Error();
    return url.href;
  } catch {
    throw new BillingError(400, 'BILLING_INVALID_URL');
  }
}

/** @param {unknown} value */
export function billingIdentifier(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 128 ||
    /[\u0000-\u0020\u007f]/u.test(value)
  )
    throw new BillingError(400, 'INVALID_REQUEST');
  return value;
}

/** @param {unknown} value */
export function billingCents(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new BillingError(400, 'BILLING_INVALID_AMOUNT');
  return Number(value);
}
