export { createContactIdentityService } from './application/contact-identity-service.js';
export { backfillContactPhoneLookup } from './application/backfill-phone-lookup.js';
export {
  encryptSiteContactClaim,
  decryptSiteContactClaim,
} from './domain/site-contact-claim.js';
export {
  ContactIdentityConflictError,
  ContactIdentityError,
  ContactIdentityForbiddenError,
  ContactIdentityNotFoundError,
  ContactIdentityValidationError,
} from './domain/errors.js';
export { InMemoryContactIdentityRepository } from './adapters/in-memory-contact-identity-repository.js';
export { PostgresContactConversionPort } from './adapters/postgres-contact-conversion-port.js';
export { PostgresContactIdentityRepository } from './adapters/postgres-contact-identity-repository.js';
export { PostgresContactReadRepository } from './adapters/postgres-contact-read-repository.js';
export { decryptContactIdentityEnvelope } from './adapters/contact-identity-envelope.js';
export {
  contactPhoneHash,
  decryptContactDetails,
  encryptContactDetails,
  normalizeContactEmail,
  normalizeContactPhone,
} from './domain/contact-details.js';
export {
  BRAZILIAN_STATES,
  CONTACT_REGISTRATION_FIELDS,
  CONTACT_REGISTRATION_LIMITS,
  isContactRegistrationFieldsComplete,
  isValidCnpj,
  isValidCpf,
  normalizeContactRegistration,
  normalizePostalCode,
} from './domain/contact-registration.js';
export {
  decryptContactRegistration,
  encryptContactRegistration,
} from './domain/contact-registration-envelope.js';
export {
  PostalCodeLookupError,
  ViaCepPostalCodeClient,
} from './adapters/viacep-postal-code-client.js';
