export { sizePricingSummary } from './domain/size-pricing-composition.js';
// Orders module (ADR 006): the Pedido aggregate, its ficha and persistence.
export {
  prepareExactCentExport,
  reconcileExactCentExport,
} from './domain/olist-exact-cent.js';
export {
  calculateSizePricing,
  changeSizePricingQuantity,
  createSizePricing,
  duplicateSizePricingGroup,
  reviewSizePricingSubtotal,
} from './domain/size-pricing.js';
export {
  BillingError,
  billingPercent,
  billingSplit,
  billingUrl,
  billingIdentifier,
  billingCents,
} from './domain/billing.js';
export {
  encryptJson as encryptOrderPrivateJson,
  decryptJson as decryptOrderPrivateJson,
} from './adapters/envelope.js';
export {
  FinanceError,
  financeQuery,
  financeVersions,
} from './domain/finance.js';
export { PostgresFinanceRepository } from './adapters/postgres-finance-repository.js';
export { InMemoryOrderRepository } from './adapters/in-memory-order-repository.js';
export { PostgresOrderConversationPort } from './adapters/postgres-order-conversation-port.js';
export { PostgresOrderRepository } from './adapters/postgres-order-repository.js';
export { PostgresOrderFileRepository } from './adapters/postgres-order-file-repository.js';
export {
  InMemoryObjectStorage,
  InMemoryOrderFileRepository,
} from './adapters/in-memory-order-files.js';
export {
  ObjectStorageUnavailableError,
  S3ObjectStorage,
  objectStorageFromEnvironment,
} from './adapters/s3-object-storage.js';
export {
  ORDER_FILE_LIMITS,
  createOrderFileService,
} from './application/order-file-service.js';
export {
  MAX_ORDER_FILE_BYTES,
  MAX_ORDER_REFERENCE_FILES,
  MAX_ORDER_THUMBNAIL_BYTES,
  ORDER_FILE_FORMATS,
  OrderFileTooLargeError,
  describeOrderFile,
} from './domain/order-files.js';
export {
  DEFAULT_ORDER_PAGE_SIZE,
  ORDER_SECTIONS,
  createOrderService,
} from './application/order-service.js';
export { createStoreOrderCorrectionService } from './application/store-order-correction-service.js';
export { createStoreOrderService } from './application/store-order-service.js';
export {
  STORE_ACTOR_ID,
  STORE_ACTOR_NAME,
  STORE_PAYMENT_GATEWAY,
  STORE_PAYMENT_METHOD,
  STORE_PRODUCTS,
  storeProduct,
  storeProductLabel,
} from './domain/store-catalog.js';
export {
  ORDER_ORIGINS,
  STORE_SCHEMA_VERSION,
  StoreOrderDuplicateError,
  StoreOrderError,
  buildStoreOrder,
  matchStoreCatalog,
  parseStoreOrderRecord,
  requireUnlocked,
  storeNumberFor,
  storeRecordFingerprint,
} from './domain/store-order.js';
export {
  OrderConflictError,
  OrderError,
  OrderForbiddenError,
  OrderInputError,
  OrderNotFoundError,
  OrderValidationError,
} from './domain/errors.js';
export {
  DEFERRED,
  ITEM_EXTRA_FIELDS,
  ITEM_REQUIRED_FIELDS,
  MAX_OBSERVATIONS,
  NOT_APPLICABLE,
  blankItem,
  briefingToFicha,
  itemTotal,
  normalizeFicha,
  orderTotal,
  projectBriefingOntoFicha,
  validateItems,
  validateArtwork,
  validateObservations,
  validateSummary,
} from './domain/ficha.js';
export { AUDIENCES, parseAudiences } from './domain/audiences.js';
export { parseSizes } from './domain/sizes.js';
export { formatBrlAmount, parseBrlAmount } from './domain/money.js';
export {
  ORDER_STATUSES,
  PAYMENT_CONDITIONS,
  SUMMARY_PERIODS,
  confirmOrder,
  formatOrderNumber,
  missingForConfirmation,
  operationalDay,
  promisedDeliveryOn,
  recordMilestones,
  reopenOrder,
  summaryPeriod,
} from './domain/order.js';
export {
  PRODUCTION_FIELDS,
  blankProduction,
  renderFichaHtml,
} from './print/ficha-canonical-v2.js';
export {
  PRINT_TEMPLATE,
  TEMPLATE_STORE_V1,
  TEMPLATE_V2,
  TEMPLATE_V3,
  renderOrderFicha,
} from './print/index.js';
export {
  MAX_ORDER_PAGE_SIZE,
  assertOrderRepositoryContract,
} from './ports/contracts.js';
