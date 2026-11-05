import { InboxConflictError, InboxForbiddenError } from '../domain/errors.js';
import {
  assertConversationMutation,
  assertProductionHumanSend,
  freezeInboxRecord,
  isTerminalInboxState,
} from '../domain/inbox.js';

/** @template T @param {T} value @returns {T} */
function clone(value) {
  return structuredClone(value);
}

export class InMemoryInboxRepository {
  #commands = new Map();
  #conversations = new Map();
  #messages = new Map();
  #suggestions = new Map();
  #tail = Promise.resolve();
  #pendingOrdersForConversation;

  /** @param {{pendingOrdersForConversation?: (conversationId: string) => number|Promise<number>}} [options] */
  constructor({ pendingOrdersForConversation = () => 0 } = {}) {
    this.#pendingOrdersForConversation = pendingOrdersForConversation;
  }

  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  async #exclusive(work) {
    const previous = this.#tail;
    /** @type {(() => void)|undefined} */
    let release;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = {
      commands: clone(this.#commands),
      conversations: clone(this.#conversations),
      messages: clone(this.#messages),
      suggestions: clone(this.#suggestions),
    };
    try {
      return await work();
    } catch (error) {
      this.#commands = snapshot.commands;
      this.#conversations = snapshot.conversations;
      this.#messages = snapshot.messages;
      this.#suggestions = snapshot.suggestions;
      throw error;
    } finally {
      release?.();
    }
  }

  /** @param {any} input @param {any} runtime */
  async receiveInbound(input, runtime) {
    return this.#exclusive(async () => {
      const messageKey = `${input.provider}\u0000${input.providerAccountId}\u0000${input.externalMessageId}`;
      const existingMessage = this.#messages.get(messageKey);
      if (existingMessage) return clone(existingMessage.result);

      const scope = `${input.provider}\u0000${input.providerAccountId}\u0000${input.externalConversationId}`;
      const scoped = [...this.#conversations.values()].filter(
        (item) => item.scope === scope,
      );
      let conversation = scoped.find((item) => item.terminalAt === null);
      if (!conversation) {
        conversation = {
          automationEpoch: 0,
          automationState: 'assistant',
          contactId: input.contactId,
          createdAt: input.occurredAt,
          cycleNumber:
            scoped.reduce(
              (maximum, item) => Math.max(maximum, item.cycleNumber),
              0,
            ) + 1,
          externalConversationId: input.externalConversationId,
          id: runtime.idFactory('conversation'),
          identityId: input.identityId,
          previousConversationId:
            scoped.sort(
              (left, right) => right.cycleNumber - left.cycleNumber,
            )[0]?.id ?? null,
          provider: input.provider,
          providerAccountId: input.providerAccountId,
          scope,
          state: 'nova',
          terminalAt: null,
          updatedAt: input.occurredAt,
          version: 1,
        };
        this.#conversations.set(conversation.id, conversation);
      } else if (conversation.identityId !== input.identityId) {
        throw new InboxConflictError(
          'An active conversation cannot change its anchored identity',
        );
      } else {
        conversation.updatedAt =
          input.occurredAt > conversation.updatedAt
            ? input.occurredAt
            : conversation.updatedAt;
        conversation.version += 1;
        conversation.archivedAt = null;
      }
      const message = {
        authorId: null,
        content: clone(input.message.content),
        conversationId: conversation.id,
        createdAt: input.occurredAt,
        direction: 'inbound',
        externalMessageId: input.externalMessageId,
        id: runtime.idFactory('message'),
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        status: 'received',
        type: input.message.type,
      };
      const result = freezeInboxRecord({
        conversation: publicConversation(conversation),
        message: freezeInboxRecord(message),
      });
      this.#messages.set(messageKey, { message, result });
      return clone(result);
    });
  }

  /** @param {string} kind @param {any} input @param {any} runtime */
  async mutateConversation(kind, input, runtime) {
    // ADR 015: the former `reactivate` is refused before anything is read.
    assertConversationMutation(kind);
    return this.#exclusive(async () => {
      const commandKey = `${kind}\u0000${input.idempotencyKey}`;
      const fingerprint = JSON.stringify(input);
      const existing = this.#commands.get(commandKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new InboxConflictError(
            'Idempotency key was reused with another command',
          );
        }
        return clone(existing.result);
      }
      const conversation = this.#conversations.get(input.conversationId);
      if (!conversation)
        throw new InboxConflictError('Conversation was not found');
      if (conversation.version !== input.expectedVersion) {
        throw new InboxConflictError(
          `Expected conversation version ${input.expectedVersion}, current version is ${conversation.version}`,
        );
      }
      if (conversation.terminalAt !== null) {
        throw new InboxConflictError(
          'Terminal conversations cannot be mutated',
        );
      }
      if (
        kind === 'unarchive' &&
        (conversation.archivedAt === null ||
          conversation.archivedAt === undefined)
      ) {
        throw new InboxConflictError('Conversation is not archived');
      }
      const isAdmin = [...(input.actor.capabilities ?? [])].includes(
        'COMMERCIAL_ADMIN',
      );
      if (
        (kind === 'archive' || kind === 'unarchive') &&
        (conversation.assignedUserId === null ||
          conversation.assignedUserId === undefined) &&
        !isAdmin
      ) {
        throw new InboxForbiddenError(
          'Conversation must be taken over before it can be archived',
        );
      }
      if (
        conversation.assignedUserId !== null &&
        conversation.assignedUserId !== undefined &&
        conversation.assignedUserId !== input.actor.id &&
        !isAdmin
      ) {
        throw new InboxForbiddenError(
          'Conversation is assigned to another operator',
        );
      }
      if (kind === 'send')
        assertProductionHumanSend(
          conversation.provider,
          conversation.providerAccountId,
        );
      if (kind === 'transition' && input.state === 'encerrada') {
        if (!conversation.assignedUserId && !isAdmin) {
          throw new InboxForbiddenError(
            'Take over the conversation before closing it',
          );
        }
        if (
          (await this.#pendingOrdersForConversation(input.conversationId)) >
            0 &&
          !input.acknowledgePending
        ) {
          throw new InboxConflictError(
            'Pending order requires acknowledgement',
          );
        }
      }

      const occurredAt = runtime.clock().toISOString();
      let result;
      if (kind === 'transition') {
        conversation.state = input.state;
        if (input.state === 'encerrada') {
          conversation.closureOutcome = input.outcome;
          conversation.closedBy = input.actor.id;
          conversation.automationEpoch += 1;
        }
        conversation.terminalAt = isTerminalInboxState(input.state)
          ? occurredAt
          : null;
        conversation.updatedAt = occurredAt;
        conversation.version += 1;
        result = publicConversation(conversation);
      } else if (kind === 'archive') {
        conversation.archivedAt = occurredAt;
        conversation.version += 1;
        result = publicConversation(conversation);
      } else if (kind === 'unarchive') {
        conversation.archivedAt = null;
        conversation.version += 1;
        result = publicConversation(conversation);
      } else if (kind === 'takeover') {
        conversation.automationState = 'human';
        conversation.automationEpoch += 1;
        conversation.state = 'em_atendimento';
        conversation.assignedUserId = input.actor.id;
        conversation.updatedAt = occurredAt;
        conversation.version += 1;
        result = publicConversation(conversation);
      } else if (kind === 'transfer') {
        conversation.automationState = 'human';
        conversation.state = 'em_atendimento';
        conversation.assignedUserId = input.targetUserId;
        conversation.updatedAt = occurredAt;
        conversation.version += 1;
        result = publicConversation(conversation);
      } else {
        // `send`, the last approved mutation.
        if (conversation.automationState === 'assistant') {
          conversation.automationEpoch += 1;
        }
        conversation.automationState = 'human';
        conversation.assignedUserId = input.actor.id;
        conversation.state = 'em_atendimento';
        conversation.updatedAt = occurredAt;
        conversation.version += 1;
        const message = freezeInboxRecord({
          authorId: input.actor.id,
          content: clone(input.content),
          conversationId: conversation.id,
          conversationVersion: conversation.version,
          createdAt: occurredAt,
          direction: 'outbound',
          externalMessageId: null,
          id: runtime.idFactory('message'),
          provider: conversation.provider,
          providerAccountId: conversation.providerAccountId,
          status: 'queued',
          type: input.messageType,
        });
        this.#messages.set(`command\u0000${input.idempotencyKey}`, {
          message,
          result: message,
        });
        result = message;
      }

      await runtime.appendAudit(
        createAudit(kind, input, conversation, occurredAt),
      );
      const frozen = freezeInboxRecord(result);
      this.#commands.set(commandKey, { fingerprint, result: frozen });
      return clone(frozen);
    });
  }

  /** @param {any} input @param {any} runtime */
  async recordSuggestion(input, runtime) {
    return this.#exclusive(async () => {
      const key = `${input.sourceMessageId}\u0000${input.proposedStage}`;
      const existing = this.#suggestions.get(key);
      if (existing) return clone(existing);
      const conversation = this.#conversations.get(input.conversationId);
      if (!conversation)
        throw new InboxConflictError('Conversation was not found');
      const suggestion = freezeInboxRecord({
        automationEpoch: conversation.automationEpoch,
        conversationId: conversation.id,
        createdAt: runtime.clock().toISOString(),
        createdBy: input.actor.id,
        id: runtime.idFactory('suggestion'),
        proposedStage: input.proposedStage,
        question: input.question,
        resolvedAt: null,
        sourceMessageId: input.sourceMessageId,
        status: 'pending',
      });
      this.#suggestions.set(key, suggestion);
      return clone(suggestion);
    });
  }
}

/** @param {any} conversation */
function publicConversation(conversation) {
  const value = clone(conversation);
  delete value.scope;
  return freezeInboxRecord(clone(value));
}

/** @param {string} kind @param {any} input @param {any} conversation @param {string} occurredAt */
function createAudit(kind, input, conversation, occurredAt) {
  const actions = {
    archive: 'conversation.archived',
    unarchive: 'conversation.unarchived',
    send: 'conversation.human_message_queued',
    takeover: 'conversation.takeover',
    transfer: 'conversation.transferred',
    transition: 'conversation.state_transitioned',
  };
  return freezeInboxRecord({
    action: actions[/** @type {keyof typeof actions} */ (kind)],
    actor: input.actor.id,
    correlationId: input.correlationId,
    occurredAt,
    reason: input.reason,
    target: { id: conversation.id, type: 'conversation' },
    version: conversation.version,
  });
}
