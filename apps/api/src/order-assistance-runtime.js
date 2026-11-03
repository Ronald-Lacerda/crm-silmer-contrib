import {
  createOrderAssistanceService,
  PostgresOrderAssistanceRepository,
} from '@crm-silmer/inbox-channels';
import {
  createOrderService,
  PostgresOrderRepository,
  PostgresOrderConversationPort,
} from '@crm-silmer/orders';

/** OA-T01: compose order creation on the suggestion decision's transaction. @param {{database:any,environment?:Record<string,string|undefined>,orders:any,access?:any,clock?:()=>Date}} options */
export function createOrderAssistanceRuntime(options) {
  const environment = options.environment ?? process.env;
  const envelopeKey = key(environment.N8N_INTEGRATION_ENVELOPE_KEY);
  const contactEnvelopeKey = key(environment.CONTACT_IDENTITY_ENVELOPE_KEY);
  const contactLookupKey = key(environment.CONTACT_IDENTITY_LOOKUP_KEY);
  const access = options.access ?? options.orders;
  const repository = new PostgresOrderAssistanceRepository({
    database: options.database,
    envelopeKey,
    clock: options.clock,
    async createPending(tx, input, details) {
      const database = {
        query: tx.query.bind(tx),
        transaction: async (/** @type {any} */ operation) => operation(tx),
      };
      const port = new PostgresOrderConversationPort({
        database,
        envelopeKey,
        contactEnvelopeKey,
        contactLookupKey,
      });
      /** @type {Record<string,unknown>} */
      let mergedBriefing = {};
      const service = createOrderService({
        repository: new PostgresOrderRepository({ database, envelopeKey }),
        fabCode: environment.FAB_CODE ?? 'FAB 01',
        clock: options.clock,
        async authorizeOwnership() {
          /* The decision owns the locked conversation and checked its human owner. */
        },
        conversations: {
          searchConversationIds: port.searchConversationIds.bind(port),
          async readOrderContexts(ids) {
            const contexts = await port.readOrderContexts(ids);
            for (const context of contexts.values()) {
              mergedBriefing = {
                ...(input.subjectId ? details.baseBriefing : context.briefing),
                ...(details.briefing ?? {}),
              };
              context.briefing = mergedBriefing;
            }
            return contexts;
          },
        },
      });
      const result = await service.createManual({
        actor: input.actor,
        conversationId: input.conversationId,
        correlationId: input.correlationId,
      });
      return { ...result, briefing: mergedBriefing };
    },
  });
  const service = createOrderAssistanceService(repository);
  return Object.freeze({
    ...service,
    authorizeRead: access.authorizeRead.bind(access),
    authorizeWrite: access.authorizeWrite.bind(access),
  });
}

/** @param {string|undefined} value */
function key(value) {
  if (!value || !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value))
    throw new Error('ORDER_ASSISTANCE_KEY_REQUIRED');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 32) throw new Error('ORDER_ASSISTANCE_KEY_INVALID');
  return decoded;
}
