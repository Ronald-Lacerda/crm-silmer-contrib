export class InboxError extends Error {
  /**
   * `statusCode` is what the HTTP boundary reads to classify a failure. Without
   * it every domain error fell through as an unclassified 500, so a seller who
   * touched someone else's conversation saw "service unavailable" instead of a
   * refusal, and a version conflict never reached the client as a conflict.
   *
   * @param {string} message @param {string} code @param {number} statusCode
   */
  constructor(message, code, statusCode) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class InboxValidationError extends InboxError {
  /** @param {string} message */
  constructor(message) {
    super(message, 'INBOX_INVALID', 400);
  }
}

export class InboxForbiddenError extends InboxError {
  /** @param {string} [message] */
  constructor(message = 'A human actor is required for this inbox mutation') {
    super(message, 'INBOX_FORBIDDEN', 403);
  }
}

export class InboxConflictError extends InboxError {
  /** @param {string} [message] */
  constructor(message = 'The inbox resource changed before this command') {
    super(message, 'INBOX_CONFLICT', 409);
  }
}

export class InboxNonProductionConversationError extends InboxError {
  constructor() {
    super(
      'Esta conversa é de teste e não envia mensagens pelo WhatsApp.',
      'NON_PRODUCTION_CONVERSATION',
      403,
    );
  }
}
