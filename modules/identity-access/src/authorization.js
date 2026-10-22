export const CAPABILITIES = Object.freeze({
  COMMERCIAL_ADMIN: 'COMMERCIAL_ADMIN',
});

/**
 * @typedef {'COMMERCIAL_ADMIN'} Capability
 * @typedef {'Vendedor'|'Financeiro'} OperationalFunction
 */

/**
 * Single source of truth for the operational actions any active seller may run.
 * API guards MUST import this set instead of redeclaring it: the previous
 * duplicate in `apps/api/src/identity-runtime.js` drifted and denied every
 * Inbox write command with 403.
 */
export const OPERATIONAL_ACTIONS = Object.freeze(
  new Set([
    'contact.identity.merge',
    'contact.identity.unmerge',
    'contact.create',
    'contact.read',
    'contact.rename',
    'conversation.convert',
    'conversation.archive',
    'conversation.read',
    'conversation.subject.manage',
    'conversation.message.send',
    'conversation.reactivate-agent',
    'conversation.takeover',
    'conversation.transfer',
    'conversation.transition',
    'conversation.unarchive',
    'deal.assign',
    'deal.draft.edit',
    'deal.draft.read',
    'deal.events.read',
    'deal.fields.patch',
    'deal.lose',
    'deal.read',
    'deal.transition',
    'handoff.accept',
    'handoff.claim',
    'handoff.create',
    'handoff.read',
    'handoff.resolve',
    'handoff.transfer',
    'kanban.read',
    // Pedido (ADR 006). Any seller passes the allowlist; writes are further
    // limited to the conversation owner or COMMERCIAL_ADMIN by the orders
    // runtime, while reading and printing stay open to every seller.
    'order.confirm',
    'order.create',
    'order.edit',
    // ADR 008: the paid and delivered days, recorded in either status.
    'order.milestones',
    'order.print',
    'order.read',
    'order.reopen',
    'task.cancel',
    'task.complete',
    'task.create',
    'task.start',
    'user.assignable.read',
  ]),
);

/**
 * Order actions only the n8n technical actor may run: the agent creates the
 * pending order when it confirms a purchase intent. No human function or
 * capability opens them, so `authorize` denies them to every user.
 */
export const AUTOMATION_ORDER_ACTIONS = Object.freeze(['order.intent']);

/**
 * ADR 028: the n8n checkout workflow records the site shop's paid order. No
 * human function or capability opens it either.
 */
export const AUTOMATION_STORE_ACTIONS = Object.freeze(['store.order.record']);

export const FINANCE_ACTIONS = Object.freeze(
  new Set(['finance.read', 'finance.complete', 'finance.reopen']),
);

const operationalActions = OPERATIONAL_ACTIONS;
/** @type {Map<string, Capability>} */
const actionCapabilities = new Map([
  ['conversation.archive', CAPABILITIES.COMMERCIAL_ADMIN],
  ['order-form.approve', CAPABILITIES.COMMERCIAL_ADMIN],
  ['order-form.cancel', CAPABILITIES.COMMERCIAL_ADMIN],
  ['order-form.resend', CAPABILITIES.COMMERCIAL_ADMIN],
  ['order-form.retry', CAPABILITIES.COMMERCIAL_ADMIN],
  ['order-form.send', CAPABILITIES.COMMERCIAL_ADMIN],
  ['quote.approve', CAPABILITIES.COMMERCIAL_ADMIN],
  ['sale.approve', CAPABILITIES.COMMERCIAL_ADMIN],
  ['user.manage', CAPABILITIES.COMMERCIAL_ADMIN],
]);
/** @type {Set<Capability>} */
const knownCapabilities = new Set(Object.values(CAPABILITIES));

export class AccessControlError extends Error {
  /** @param {number} statusCode @param {string} code @param {string} message */
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'AccessControlError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** @param {string} message */
function forbidden(message) {
  return new AccessControlError(403, 'FORBIDDEN', message);
}

/** @param {string} message */
function invalidRequest(message) {
  return new AccessControlError(400, 'INVALID_REQUEST', message);
}

/** @param {string} message */
function notFound(message) {
  return new AccessControlError(404, 'NOT_FOUND', message);
}

/**
 * @typedef {{ id: string, kind?: 'human'|'assistant', functionName: OperationalFunction, capabilities: Capability[] }} AccessActor
 */

/**
 * Enforces the same deny-by-default policy that API guards and UI capability
 * views consume. The UI may hide controls, but this policy remains authoritative.
 * @param {AccessActor} actor
 * @param {string} action
 */
export function authorize(actor, action) {
  if (actor.kind === 'assistant') throw forbidden('Forbidden');
  if (FINANCE_ACTIONS.has(action)) {
    if (
      (actor.functionName === 'Financeiro' &&
        actor.capabilities.length === 0) ||
      (action === 'finance.read' &&
        actor.functionName === 'Vendedor' &&
        actor.capabilities.includes(CAPABILITIES.COMMERCIAL_ADMIN))
    )
      return;
    throw forbidden('Forbidden');
  }
  if (actor.functionName !== 'Vendedor') throw forbidden('Forbidden');
  if (operationalActions.has(action) && actor.functionName === 'Vendedor') {
    return;
  }
  const required = actionCapabilities.get(action);
  if (!required || !actor.capabilities.includes(required)) {
    throw forbidden('Forbidden');
  }
}

/**
 * @typedef {{
 *   actorId: string,
 *   capability: Capability,
 *   correlationId: string,
 *   reason: string,
 *   targetId: string
 * }} CapabilityCommand
 */

/**
 * @param {{
 *   auditPort: { append: (event: {
 *     actor: string,
 *     action: string,
 *     target: {type: string, id: string},
 *     version: string | number,
 *     reason: string,
 *     correlationId: string,
 *   }) => Promise<unknown> },
 *   clock?: () => Date,
 *   repository: {
 *     findUser: (id: string) => Promise<AccessActor | null>,
 *     grant: (id: string, capability: Capability, grantedBy: string) => Promise<unknown>,
 *     revoke: (id: string, capability: Capability) => Promise<unknown>,
 *     revokePrivilegedSessions: (id: string, occurredAt: string) => Promise<unknown>
 *   }
 * }} options
 */
export function createAccessControlService({
  auditPort,
  clock = () => new Date(),
  repository,
}) {
  /** @param {CapabilityCommand} input */
  async function validate(input) {
    if (!knownCapabilities.has(input.capability)) {
      throw invalidRequest('Unknown capability');
    }
    requireNonEmpty(input.actorId, 'actorId');
    requireNonEmpty(input.targetId, 'targetId');
    requireNonEmpty(input.reason, 'reason');
    requireNonEmpty(input.correlationId, 'correlationId');
    const actor = await repository.findUser(input.actorId);
    if (
      !actor ||
      actor.functionName !== 'Vendedor' ||
      !actor.capabilities.includes(CAPABILITIES.COMMERCIAL_ADMIN)
    ) {
      throw forbidden('Forbidden');
    }
    const target = await repository.findUser(input.targetId);
    if (!target) throw notFound('User not found');
    return { actor, target };
  }

  /** @param {'granted'|'revoked'} change @param {CapabilityCommand} input */
  async function audit(change, input) {
    await auditPort.append({
      action: `identity.capability.${change}`,
      actor: input.actorId,
      correlationId: input.correlationId,
      reason: input.reason,
      target: { id: input.targetId, type: 'user' },
      version: input.capability,
    });
  }

  /** @param {CapabilityCommand} input */
  async function grantCapability(input) {
    const { target } = await validate(input);
    if (target.functionName !== 'Vendedor') {
      throw forbidden(
        'Change the user access type to grant administrative access',
      );
    }
    if (input.actorId === input.targetId) {
      throw forbidden('An Admin cannot self-assign capabilities');
    }
    await repository.grant(input.targetId, input.capability, input.actorId);
    await audit('granted', input);
  }

  /** @param {CapabilityCommand} input */
  async function revokeCapability(input) {
    await validate(input);
    if (
      input.capability === CAPABILITIES.COMMERCIAL_ADMIN &&
      input.actorId === input.targetId
    ) {
      throw forbidden('Another Admin must revoke COMMERCIAL_ADMIN');
    }
    await repository.revoke(input.targetId, input.capability);
    await repository.revokePrivilegedSessions(
      input.targetId,
      clock().toISOString(),
    );
    await audit('revoked', input);
  }

  return Object.freeze({ grantCapability, revokeCapability });
}

/** @param {unknown} value @param {string} field */
function requireNonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}
