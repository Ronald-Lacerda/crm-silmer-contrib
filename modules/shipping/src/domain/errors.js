// Shipping errors carry `code` and `statusCode`, the contract the HTTP
// boundary reads to classify a failure (the same shape as OrderError).
export class ShippingError extends Error {
  /** @param {string} message @param {string} code @param {number} statusCode */
  constructor(message, code, statusCode) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * A rejected shipping rule (422). `fields` names what has to be fixed so the
 * page can show it next to the field instead of a banner.
 */
export class ShippingValidationError extends ShippingError {
  /**
   * @param {string} message
   * @param {string} code
   * @param {readonly string[]} [fields]
   */
  constructor(message, code, fields = []) {
    super(message, code, 422);
    this.fields = Object.freeze([...fields]);
  }
}
