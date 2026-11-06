import { createHash, timingSafeEqual } from 'node:crypto';

import {
  AUTOMATION_ORDER_ACTIONS,
  AUTOMATION_STORE_ACTIONS,
} from './authorization.js';

export const AUTOMATION_EXECUTOR_ACTOR = Object.freeze({
  id: 'AUTOMATION_EXECUTOR',
  kind: 'AUTOMATION_EXECUTOR',
  role: 'AUTOMATION_EXECUTOR',
});

export const AUTOMATION_EXECUTOR_ACTIONS = Object.freeze([
  'integration.n8n.message.create',
  'integration.n8n.attachment.create',
  'integration.n8n.event.create',
  'integration.n8n.command.media.read',
  'dashboard.checkpoint.execute',
  'conversation.convert',
  'deal.fields.patch',
  'deal.transition',
  'handoff.create',
  'billing.checkout.reserve',
  'billing.checkout.record',
  'billing.checkout.read',
  'billing.payment.record',
  ...AUTOMATION_ORDER_ACTIONS,
  ...AUTOMATION_STORE_ACTIONS,
]);

const allowedActions = new Set(AUTOMATION_EXECUTOR_ACTIONS);
const unavailablePreviousSecretDigest = digest(
  'no-previous-automation-secret-is-configured',
);

/**
 * @typedef {{
 *   actor: typeof AUTOMATION_EXECUTOR_ACTOR,
 *   credentialVersion: 'current'|'previous',
 * }} AutomationPrincipal
 */

/** @param {string} value */
function digest(value) {
  return createHash('sha256').update(value).digest();
}

/** @param {Buffer} left @param {Buffer} right */
function equalDigest(left, right) {
  return timingSafeEqual(left, right);
}

/** @param {unknown} value */
function requireClientId(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    value.includes(':') ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError('clientId must be a non-empty HTTP Basic identifier');
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requireSecret(value, field) {
  if (typeof value !== 'string' || value.length < 32) {
    throw new TypeError(`${field} secret must contain at least 32 characters`);
  }
  return value;
}

/**
 * Holds only SHA-256 digests of the configured server-to-server credential.
 * Rotation overlap is explicit: the previous secret is valid only when it is
 * supplied while constructing this process-local verifier.
 *
 * @param {{clientId: string, currentSecret: string, previousSecret?: string}} configuration
 */
export function createAutomationCredentials(configuration) {
  const clientIdDigest = digest(requireClientId(configuration.clientId));
  const currentSecretDigest = digest(
    requireSecret(configuration.currentSecret, 'currentSecret'),
  );
  const hasPreviousSecret = configuration.previousSecret !== undefined;
  const previousSecretDigest = hasPreviousSecret
    ? digest(requireSecret(configuration.previousSecret, 'previousSecret'))
    : unavailablePreviousSecretDigest;

  return Object.freeze({
    /**
     * @param {unknown} clientId
     * @param {unknown} secret
     * @returns {Readonly<AutomationPrincipal>|null}
     */
    authenticate(clientId, secret) {
      const suppliedClientIdDigest = digest(
        typeof clientId === 'string' ? clientId : '',
      );
      const suppliedSecretDigest = digest(
        typeof secret === 'string' ? secret : '',
      );
      const clientMatches = equalDigest(suppliedClientIdDigest, clientIdDigest);
      const currentMatches = equalDigest(
        suppliedSecretDigest,
        currentSecretDigest,
      );
      const previousDigestMatches = equalDigest(
        suppliedSecretDigest,
        previousSecretDigest,
      );
      const previousMatches = hasPreviousSecret && previousDigestMatches;

      if (!clientMatches || (!currentMatches && !previousMatches)) return null;
      return Object.freeze({
        actor: AUTOMATION_EXECUTOR_ACTOR,
        credentialVersion: currentMatches ? 'current' : 'previous',
      });
    },

    /** @param {unknown} action */
    isActionAllowed(action) {
      return typeof action === 'string' && allowedActions.has(action);
    },
  });
}
