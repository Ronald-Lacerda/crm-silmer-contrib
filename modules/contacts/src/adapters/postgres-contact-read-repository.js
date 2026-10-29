import { decryptContactIdentityEnvelope } from './contact-identity-envelope.js';
import {
  contactPhoneHash,
  decryptContactDetails,
  normalizeContactPhone,
} from '../domain/contact-details.js';
import { decryptContactRegistration } from '../domain/contact-registration-envelope.js';
import { decryptSiteContactClaim } from '../domain/site-contact-claim.js';

export class PostgresContactReadRepository {
  /** @param {{database: {query: Function, transaction?: Function}, envelopeKey: Buffer, lookupKey: Buffer}} options */
  constructor({ database, envelopeKey, lookupKey }) {
    if (!database || typeof database.query !== 'function') {
      throw new TypeError('database.query is required');
    }
    if (!Buffer.isBuffer(envelopeKey) || envelopeKey.length !== 32) {
      throw new TypeError('envelopeKey must be a 32-byte Buffer');
    }
    if (!Buffer.isBuffer(lookupKey) || lookupKey.length !== 32) {
      throw new TypeError('lookupKey must be a 32-byte Buffer');
    }
    this.database = database;
    this.envelopeKey = Buffer.from(envelopeKey);
    this.lookupKey = Buffer.from(lookupKey);
  }

  /** @param {{after: null|{updatedAt: string, id: string}, limit: number, q?: string}} input */
  async list(input) {
    return this.#snapshot(async (database) => {
      const values = [];
      const afterPredicate = input.after
        ? (() => {
            values.push(input.after.updatedAt, input.after.id);
            return '(contact.updated_at, contact.id) < ($1, $2)';
          })()
        : 'true';
      const q = (input.q ?? '').trim();
      const searchPattern = q.replace(/[\\%_]/gu, '\\$&');
      const phone = normalizeContactPhone(q);
      if (q)
        values.push(
          phone
            ? contactPhoneHash(phone, this.lookupKey)
            : `%${searchPattern}%`,
        );
      const searchValue = values.length;
      const searchPredicate = q
        ? phone
          ? `(EXISTS (
               SELECT 1 FROM crm.contact_phone_lookup phone_lookup
               LEFT JOIN crm.contact_identities phone_identity
                 ON phone_identity.id = phone_lookup.identity_id
               WHERE phone_lookup.phone_hash = $${searchValue}
                 AND ((phone_lookup.source = 'manual'
                       AND phone_lookup.contact_id = contact.id)
                      OR (phone_lookup.source = 'whatsapp'
                          AND phone_identity.current_contact_id = contact.id))
             ) OR EXISTS (
               SELECT 1 FROM crm.site_contact_claims site_claim
               JOIN crm.conversations site_conversation
                 ON site_conversation.id = site_claim.conversation_id
               JOIN crm.contact_identities site_identity
                 ON site_identity.id = site_conversation.contact_identity_id
               WHERE site_identity.current_contact_id = contact.id
                 AND site_claim.phone_hash = $${searchValue}
             ))`
          : `contact.display_name ILIKE $${searchValue} ESCAPE '\\'`
        : 'true';
      values.push(input.limit + 1);
      const [page, count] = await Promise.all([
        database.query(
          // ADR 047: the list never reads the registration envelope, only
          // its non-sensitive completeness flag.
          `WITH contact_page AS (
             SELECT contact.id, contact.display_name, contact.provisional,
                    contact.version, contact.created_at, contact.updated_at,
                    contact.contact_details_envelope,
                    contact.registration_fields_complete
             FROM crm.contacts AS contact
             WHERE ${afterPredicate} AND ${searchPredicate}
             ORDER BY contact.updated_at DESC, contact.id DESC
             LIMIT $${values.length}
           )
           SELECT contact_page.*,
                  identity.id identity_id, identity.channel,
                  identity.identity_kind, identity.phone_status,
                  identity.external_identity_lookup_hash,
                  identity.identity_envelope,
                  site_claim.id site_claim_id,
                  site_claim.version site_claim_version,
                  site_claim.details_envelope site_claim_envelope,
                  GREATEST(
                    contact_page.updated_at,
                    COALESCE((SELECT max(conversation.last_message_at)
                              FROM crm.contact_identities linked_identity
                              JOIN crm.conversations conversation
                                ON conversation.contact_identity_id=linked_identity.id
                              WHERE linked_identity.current_contact_id=contact_page.id),
                             contact_page.updated_at)
                  ) latest_activity_at
           FROM contact_page
           LEFT JOIN crm.contact_identities identity
             ON identity.current_contact_id=contact_page.id
           LEFT JOIN LATERAL (
             SELECT site_claim.id, site_claim.version,
                    site_claim.details_envelope
             FROM crm.site_contact_claims site_claim
             JOIN crm.conversations site_conversation
               ON site_conversation.id = site_claim.conversation_id
             JOIN crm.contact_identities site_identity
               ON site_identity.id = site_conversation.contact_identity_id
             WHERE site_identity.current_contact_id = contact_page.id
               ${phone ? `AND site_claim.phone_hash = $${searchValue}` : ''}
             ORDER BY site_claim.updated_at DESC, site_claim.id DESC
             LIMIT 1
           ) site_claim ON true
           ORDER BY contact_page.updated_at DESC, contact_page.id DESC,
                    identity.created_at, identity.id`,
          values,
        ),
        database.query(
          `SELECT count(*)::integer count FROM crm.contacts contact
           WHERE ${
             q
               ? phone
                 ? `EXISTS (
             SELECT 1 FROM crm.contact_phone_lookup phone_lookup
             LEFT JOIN crm.contact_identities phone_identity
               ON phone_identity.id = phone_lookup.identity_id
             WHERE phone_lookup.phone_hash = $1
               AND ((phone_lookup.source = 'manual'
                     AND phone_lookup.contact_id = contact.id)
                    OR (phone_lookup.source = 'whatsapp'
                        AND phone_identity.current_contact_id = contact.id))
           ) OR EXISTS (
             SELECT 1 FROM crm.site_contact_claims site_claim
             JOIN crm.conversations site_conversation
               ON site_conversation.id = site_claim.conversation_id
             JOIN crm.contact_identities site_identity
               ON site_identity.id = site_conversation.contact_identity_id
             WHERE site_identity.current_contact_id = contact.id
               AND site_claim.phone_hash = $1
           )`
                 : "contact.display_name ILIKE $1 ESCAPE '\\'"
               : 'true'
           }`,
          q
            ? [
                phone
                  ? contactPhoneHash(phone, this.lookupKey)
                  : `%${searchPattern}%`,
              ]
            : [],
        ),
      ]);
      const contacts = groupContacts(
        page.rows,
        this.envelopeKey,
        Boolean(phone),
      );
      const hasMore = contacts.length > input.limit;
      return {
        hasMore,
        items: contacts.slice(0, input.limit),
        totalCount: Number(count.rows[0]?.count ?? 0),
      };
    });
  }

  /** @param {string} contactId */
  async get(contactId) {
    return this.#snapshot(async (database) => {
      const [contact, identities, conversations, siteClaims] =
        await runSequential([
          () =>
            database.query(
              `SELECT id, display_name, provisional, version, created_at,
                    updated_at, contact_details_envelope,
                    registration_envelope, registration_fields_complete
             FROM crm.contacts WHERE id=$1`,
              [contactId],
            ),
          () =>
            database.query(
              `SELECT id, channel, identity_kind, phone_status,
                    external_identity_lookup_hash, identity_envelope,
                    created_at, updated_at
             FROM crm.contact_identities
             WHERE current_contact_id=$1 ORDER BY created_at, id`,
              [contactId],
            ),
          () =>
            database.query(
              `SELECT conversation.id, conversation.state,
                    conversation.automation_state, conversation.version,
                    conversation.opened_at, conversation.last_message_at,
                    conversation.terminal_at, identity.channel
             FROM crm.conversations conversation
             JOIN crm.contact_identities identity
               ON identity.id=conversation.contact_identity_id
             WHERE identity.current_contact_id=$1
             ORDER BY conversation.last_message_at DESC, conversation.id DESC`,
              [contactId],
            ),
          () =>
            database.query(
              `SELECT site_claim.id, site_claim.version, site_claim.details_envelope
             FROM crm.site_contact_claims site_claim
             JOIN crm.conversations site_conversation
               ON site_conversation.id = site_claim.conversation_id
             JOIN crm.contact_identities site_identity
               ON site_identity.id = site_conversation.contact_identity_id
             WHERE site_identity.current_contact_id=$1
             ORDER BY site_claim.updated_at DESC, site_claim.id DESC LIMIT 1`,
              [contactId],
            ),
        ]);
      const row = contact.rows[0];
      if (!row) throw notFound('CONTACT_NOT_FOUND');
      const identityViews = identities.rows.map((/** @type {any} */ identity) =>
        mapIdentity(identity, this.envelopeKey),
      );
      return {
        contact: mapContact(
          row,
          identityViews,
          decryptContactDetails(row.contact_details_envelope, this.envelopeKey),
          siteClaims.rows[0]
            ? decryptSiteContactClaim(
                siteClaims.rows[0].details_envelope,
                siteClaims.rows[0].id,
                Number(siteClaims.rows[0].version),
                this.envelopeKey,
              )
            : null,
          false,
          decryptContactRegistration(
            row.registration_envelope,
            this.envelopeKey,
          ),
        ),
        conversations: conversations.rows.map(
          (/** @type {any} */ conversation) => ({
            automationState: conversation.automation_state,
            channel: conversation.channel,
            id: conversation.id,
            lastMessageAt: iso(conversation.last_message_at),
            openedAt: iso(conversation.opened_at),
            state: conversation.state,
            terminalAt: conversation.terminal_at
              ? iso(conversation.terminal_at)
              : null,
            version: Number(conversation.version),
          }),
        ),
        identities: identityViews,
      };
    });
  }

  /** @template T @param {(database: any) => Promise<T>} work */
  async #snapshot(work) {
    if (typeof this.database.transaction !== 'function') {
      return work(this.database);
    }
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return work(client);
    });
  }
}

/** @param {any[]} rows @param {Buffer} key @param {boolean} matchedSitePhone */
function groupContacts(rows, key, matchedSitePhone) {
  const grouped = new Map();
  for (const row of rows) {
    let current = grouped.get(row.id);
    if (!current) {
      current = {
        createdAt: iso(row.created_at),
        displayName: row.display_name ?? null,
        id: row.id,
        identities: [],
        details: decryptContactDetails(row.contact_details_envelope, key),
        siteClaim: row.site_claim_id
          ? decryptSiteContactClaim(
              row.site_claim_envelope,
              row.site_claim_id,
              Number(row.site_claim_version),
              key,
            )
          : null,
        latestActivityAt: iso(row.latest_activity_at),
        provisional: Boolean(row.provisional),
        registration_fields_complete: row.registration_fields_complete === true,
        updatedAt: iso(row.updated_at),
        version: Number(row.version),
      };
      grouped.set(row.id, current);
    }
    if (row.identity_id) current.identities.push(mapIdentity(row, key));
  }
  return [...grouped.values()].map((contact) =>
    mapContact(
      contact,
      contact.identities,
      contact.details,
      contact.siteClaim,
      matchedSitePhone,
    ),
  );
}

/** @param {any} row @param {any[]} identities */
function mapContact(
  row,
  identities,
  details = /** @type {{email: string|null, phone: string|null}} */ ({
    email: null,
    phone: null,
  }),
  siteClaim = /** @type {{name: string, phone: string}|null} */ (null),
  matchedSitePhone = false,
  /** Only the detail passes it; `undefined` keeps it out of the list view. */
  registration = /** @type {Readonly<Record<string, string|null>>|null|undefined} */ (
    undefined
  ),
) {
  const primary =
    identities.find((identity) => identity.channel === 'whatsapp') ??
    identities[0] ??
    null;
  const confirmedPhone =
    primary?.kind === 'phone' && primary.phoneStatus === 'confirmed'
      ? normalizeContactPhone(primary.externalId)
      : null;
  const phone =
    matchedSitePhone && siteClaim
      ? siteClaim.phone
      : (row.phone ??
        details.phone ??
        confirmedPhone ??
        siteClaim?.phone ??
        null);
  const phoneSource =
    matchedSitePhone && siteClaim
      ? 'site_unverified'
      : row.phone || details.phone
        ? 'manual'
        : confirmedPhone
          ? 'whatsapp'
          : siteClaim
            ? 'site_unverified'
            : null;
  const email = details.email ?? null;
  // CP-26: registration fields plus the celular and e-mail already resolved.
  const registrationStatus =
    row.registration_fields_complete === true && phone && email
      ? 'complete'
      : 'incomplete';
  return Object.freeze({
    createdAt: row.createdAt ?? iso(row.created_at),
    displayName: row.displayName ?? row.display_name ?? null,
    id: row.id,
    identities: Object.freeze([...identities]),
    phone,
    phoneSource,
    email,
    // Operator-chosen name wins; the channel handle is only the fallback.
    label:
      row.displayName ??
      row.display_name ??
      siteClaim?.name ??
      primary?.displayHandle ??
      primary?.externalId ??
      `Contato ${row.id}`,
    latestActivityAt:
      row.latestActivityAt ?? row.updatedAt ?? iso(row.updated_at),
    provisional: Boolean(row.provisional),
    ...(registration !== undefined ? { registration } : {}),
    registrationStatus,
    updatedAt: row.updatedAt ?? iso(row.updated_at),
    version: Number(row.version),
  });
}

/** @param {any} row @param {Buffer} key */
function mapIdentity(row, key) {
  const secret = decryptContactIdentityEnvelope(
    row.identity_envelope,
    row.external_identity_lookup_hash,
    key,
  );
  return Object.freeze({
    channel: row.channel,
    displayHandle: secret.displayHandle ?? null,
    externalId: secret.externalIdentityId,
    id: row.identity_id ?? row.id,
    kind: row.identity_kind,
    phoneStatus: row.phone_status,
  });
}

/** @param {Array<() => Promise<any>>} operations */
async function runSequential(operations) {
  const results = [];
  for (const operation of operations) results.push(await operation());
  return results;
}

/** @param {any} value */
function iso(value) {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/** @param {string} code */
function notFound(code) {
  return Object.assign(new Error(code), { code, statusCode: 404 });
}
