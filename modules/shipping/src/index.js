export { ShippingError, ShippingValidationError } from './domain/errors.js';
export { DELIVERY_MODES, parseDeliveryMode } from './domain/delivery-mode.js';
export { findPostalCodes, normalizePostalCode } from './domain/postal-code.js';
export {
  CORREIOS_LIMITS,
  PACKAGE_KINDS,
  checkCarrierLimits,
  createPackageType,
} from './domain/package-type.js';
export { estimateShipment } from './domain/weight-estimate.js';
export { validatePacking } from './domain/packing.js';
export {
  allocateDeclaredValue,
  splitPackageValue,
  unitValueCents,
} from './domain/declared-value.js';
export {
  PAC_MAX_INSURANCE_CENTS,
  buildCartItem,
  buildQuoteRequest,
  labelPurchaseKey,
  missingRecipientFields,
  missingSenderFields,
} from './domain/melhor-envio-payloads.js';
export { decideFreightDifference } from './domain/freight-difference.js';
export {
  MELHOR_ENVIO_BASE_URLS,
  MELHOR_ENVIO_FILE_FORMATS,
  MELHOR_ENVIO_SAFE_TO_RETRY,
  MelhorEnvioError,
  createMelhorEnvioClient,
} from './adapters/melhor-envio-client.js';
export {
  MELHOR_ENVIO_SCOPES,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  isTokenExpiring,
  refreshAccessToken,
} from './adapters/melhor-envio-oauth.js';
export {
  MELHOR_ENVIO_SIGNATURE_HEADER,
  MELHOR_ENVIO_WEBHOOK_EVENTS,
  parseMelhorEnvioWebhook,
  verifyMelhorEnvioSignature,
} from './adapters/melhor-envio-webhook.js';
