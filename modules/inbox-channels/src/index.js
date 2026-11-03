export {
  ChannelContractError,
  createCanonicalInboundEnvelope,
  createCanonicalOutboundEnvelope,
  createScopedExternalId,
} from './domain/channel-envelope.js';
export { assertChannelAdapterContract } from './ports/contracts.js';
export {
  createMetaWhatsAppNormalizer,
  META_WHATSAPP_MAX_EVENTS_PER_CALLBACK,
  META_WHATSAPP_STALE_AFTER_HOURS,
  MetaWhatsAppWebhookPayloadError,
  normalizeMetaWhatsAppWebhook,
} from './adapters/meta-whatsapp.js';
export { InMemoryInboxRepository } from './adapters/in-memory-inbox-repository.js';
export { PostgresConversationConversionPort } from './adapters/postgres-conversation-conversion-port.js';
export { PostgresInboxRepository } from './adapters/postgres-inbox-repository.js';
export { PostgresInboxReadRepository } from './adapters/postgres-inbox-read-repository.js';
export { PostgresHandoffConversationPort } from './adapters/postgres-handoff-conversation-port.js';
export {
  createChannelEventHandler,
  createChannelEventJobHandler,
} from './application/channel-event-handler.js';
export { createInboxService } from './application/inbox-service.js';
export {
  createOrderAssistanceService,
  OrderAssistanceError,
} from './application/order-assistance.js';
export { PostgresOrderAssistanceRepository } from './adapters/postgres-order-assistance.js';
export {
  createSubjectService,
  SubjectError,
} from './application/subject-service.js';
export {
  InboxConflictError,
  InboxError,
  InboxForbiddenError,
  InboxValidationError,
} from './domain/errors.js';
export {
  CONVERSATION_MUTATIONS,
  INBOX_STATES,
  TERMINAL_INBOX_STATES,
} from './domain/inbox.js';
