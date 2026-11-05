import {
  InboxNonProductionConversationError,
  InboxValidationError,
} from './errors.js';

/** OPS-INBOX-SEND-08: use only the persisted channel account, never content,
 * contact labels or phone heuristics. Site messages keep their own transport.
 * @param {string} provider @param {string} providerAccountId
 */
export function assertProductionHumanSend(provider, providerAccountId) {
  if (
    provider === 'meta' &&
    (providerAccountId === 'dev-phone-number' ||
      providerAccountId.startsWith('synthetic-'))
  )
    throw new InboxNonProductionConversationError();
}

export const INBOX_STATES = Object.freeze([
  'nova',
  'em_analise',
  'em_atendimento',
  'requer_atencao',
  'convertida_em_lead',
  'sem_lead',
  'encerrada',
]);

export const TERMINAL_INBOX_STATES = Object.freeze(['sem_lead', 'encerrada']);

/**
 * The conversation changes a person can make. ADR 015: once a person has the
 * conversation it never goes back to the bot, so none of them sets
 * `automation_state` to `assistant`. The former `reactivate` ("Devolver à
 * IA") is refused like any unknown change; its past audit entries stay as
 * history.
 */
export const CONVERSATION_MUTATIONS = Object.freeze([
  'archive',
  'send',
  'takeover',
  'transfer',
  'transition',
  'unarchive',
]);

/** @param {unknown} kind */
export function assertConversationMutation(kind) {
  if (typeof kind !== 'string' || !CONVERSATION_MUTATIONS.includes(kind)) {
    throw new InboxValidationError(
      'kind must be an approved conversation mutation',
    );
  }
  return kind;
}

/** @param {unknown} state */
export function assertInboxState(state) {
  if (typeof state !== 'string' || !INBOX_STATES.includes(state)) {
    throw new InboxValidationError('state must be an approved inbox state');
  }
}

/** @param {unknown} state */
export function isTerminalInboxState(state) {
  return typeof state === 'string' && TERMINAL_INBOX_STATES.includes(state);
}

/** @param {unknown} value @param {string} field */
export function requireNonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InboxValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/** @param {unknown} value */
export function requireVersion(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1) {
    throw new InboxValidationError(
      'expectedVersion must be a positive integer',
    );
  }
  return value;
}

/** @template T @param {T} value @returns {T} */
export function freezeInboxRecord(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeInboxRecord(item);
    Object.freeze(value);
  }
  return value;
}
