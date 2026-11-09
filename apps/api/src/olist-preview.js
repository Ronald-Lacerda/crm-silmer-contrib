import {
  PostgresOrderRepository,
  orderSourceView,
  operationalDay,
} from '@crm-silmer/orders';
import {
  decryptContactIdentityEnvelope,
  decryptContactDetails,
  decryptContactRegistration,
  normalizeContactPhone,
} from '@crm-silmer/contacts';
import {
  lockOlistActor,
  OlistError,
  open,
  seal,
  identityHash,
  createOlistClient,
  olistReadWait,
  olistSettings,
  olistProductFiscal,
  resolveOlistExistingBuyer,
  assertOlistExistingBuyerSource,
  olistBuyerRegistrationEmpty,
} from '@crm-silmer/olist';
import { buildOlistPreviewPlan } from './olist-preview-plan.js';
import { planOlistResources } from './olist-preview-resources.js';

const TTL = 15 * 60_000;
const REVIEWED_FISCAL = Symbol('reviewed-product-fiscal');
const REVIEWED_BUYER = Symbol('reviewed-existing-buyer');
const SAFE_LOOKUP_ERRORS = new Set([
  'OLIST_AMBIGUOUS_MATCH',
  'OLIST_INCOMPLETE_LOOKUP',
  'OLIST_INVALID_RESPONSE',
  'OLIST_RECONNECT_REQUIRED',
  'OLIST_AUTH',
  'OLIST_UNAVAILABLE',
  'OLIST_RATE_LIMITED',
  'OLIST_REFRESH_IN_PROGRESS',
]);
/** T06: local snapshots are read under short locks; no HTTP inside SQL.
 * The encrypted, session-bound receipt is a review capability, never an effect reservation.
 * @param {any} database @param {{config:any,connection:any,environment:Record<string,string|undefined>,clock:()=>Date,fetch?:typeof fetch,timeoutMs?:number}} options */
export function createOlistPreview(database, options) {
  const { config, connection, clock } = options;
  const orderKey = Buffer.from(
    options.environment.N8N_INTEGRATION_ENVELOPE_KEY ?? '',
    'base64',
  );
  const contactKey = Buffer.from(
    options.environment.CONTACT_IDENTITY_ENVELOPE_KEY ?? '',
    'base64',
  );
  /** @param {any} input */
  async function snapshot(
    input,
    action = 'olist.export',
    includeResources = true,
  ) {
    const work = async (/** @type {any} */ tx) => {
      const actor = await lockOlistActor(tx, input, action, clock());
      if (
        !config.configured ||
        orderKey.length !== 32 ||
        contactKey.length !== 32
      )
        throw new OlistError('OLIST_NOT_CONFIGURED', 503);
      const connectionRows = await tx.query(
        'SELECT * FROM crm.olist_connections WHERE context_key=$1 AND account_key=$2 FOR SHARE',
        [config.contextKey, config.accountKey],
      );
      const row = connectionRows.rows[0];
      const settingsRows = await tx.query(
        'SELECT * FROM crm.olist_settings WHERE account_key=$1 FOR SHARE',
        [config.accountKey],
      );
      const settingsRow = settingsRows.rows[0];
      const orderRows = await tx.query(
        'SELECT id,cancelled_at FROM crm.orders WHERE id=$1 FOR SHARE',
        [input.orderId],
      );
      if (!orderRows.rows[0]) throw new OlistError('ORDER_NOT_FOUND', 404);
      if (orderRows.rows[0].cancelled_at)
        throw new OlistError('ORDER_CANCELLED');
      const scoped = {
        query: tx.query.bind(tx),
        transaction: async (/** @type {any} */ work) => work(tx),
      };
      const repository = new PostgresOrderRepository({
        database: scoped,
        envelopeKey: orderKey,
      });
      const order = /** @type {any} */ (
        await repository.findById(input.orderId)
      );
      const sources = await repository.readPriceBreakdowns([order]);
      const source = orderSourceView(order, sources.get(order.id) ?? null);
      /** @type {any} */
      let buyer =
        source.order && 'buyer' in source.order ? source.order.buyer : null;
      let buyerVersion = null;
      let buyerContactId = null;
      let buyerIdentities = [];
      if (order.origin !== 'loja') {
        const contactId =
          order.contactId ??
          (order.conversationId
            ? (
                await tx.query(
                  'SELECT identity.current_contact_id FROM crm.conversations conversation JOIN crm.contact_identities identity ON identity.id=conversation.contact_identity_id WHERE conversation.id=$1 FOR SHARE OF conversation,identity',
                  [order.conversationId],
                )
              ).rows[0]?.current_contact_id
            : null);
        const contacts = await tx.query(
          'SELECT id,version,display_name,contact_details_envelope,registration_envelope FROM crm.contacts WHERE id=$1 FOR SHARE',
          [contactId],
        );
        const contact = contacts.rows[0];
        if (contact) {
          const details = decryptContactDetails(
            contact.contact_details_envelope,
            contactKey,
          );
          buyerIdentities = (
            await tx.query(
              "SELECT id,channel,identity_kind,phone_status,external_identity_lookup_hash,identity_envelope FROM crm.contact_identities WHERE current_contact_id=$1 AND channel='whatsapp' AND identity_kind='phone' AND phone_status='confirmed' ORDER BY created_at,id LIMIT 101 FOR SHARE",
              [contact.id],
            )
          ).rows;
          if (buyerIdentities.length > 100)
            throw new OlistError('OLIST_INCOMPLETE_LOOKUP', 409);
          const identityPhone = buyerIdentities.length
            ? normalizeContactPhone(
                decryptContactIdentityEnvelope(
                  buyerIdentities[0].identity_envelope,
                  buyerIdentities[0].external_identity_lookup_hash,
                  contactKey,
                ).externalIdentityId,
              )
            : null;
          const registration = decryptContactRegistration(
            contact.registration_envelope,
            contactKey,
          );
          buyer = {
            name: contact.display_name ?? registration?.legalName,
            phone: details.phone ?? identityPhone,
            email: details.email,
            registration,
          };
          buyerVersion = Number(contact.version);
          buyerContactId = contact.id;
        }
      }
      const resources = includeResources
        ? (
            await tx.query(
              'SELECT id,account_key,kind,identity_hash,reference,parent_id,state,version,remote_id,verified_remote_sku FROM crm.olist_resources WHERE account_key=$1 ORDER BY id LIMIT 1001 FOR SHARE',
              [config.accountKey],
            )
          ).rows
        : [];
      // Only an ACTIVE export blocks a new preview (OLIST_OPERATION_EXISTS):
      // an administratively invalidated generation is archived history. At most
      // one active row exists per account/order (partial unique index).
      const operation =
        (
          await tx.query(
            "SELECT state,stage,version,remote_number FROM crm.olist_exports WHERE account_key=$1 AND order_id=$2 AND state<>'invalidated' ORDER BY created_at DESC,id DESC LIMIT 1",
            [config.accountKey, order.id],
          )
        ).rows[0] ?? null;
      const settings = settingsRow?.settings_envelope
        ? olistSettings(
            open(
              settingsRow.settings_envelope,
              config.envelopeKey,
              'settings',
              config.accountKey,
              'central',
            ),
          )
        : null;
      const connected =
        Boolean(row?.token_envelope) &&
        !row.reconnect_required &&
        !row.refresh_nonce &&
        !row.exchange_nonce;
      const account = (
        await tx.query(
          'SELECT creation_enabled,recovery_required FROM crm.olist_accounts WHERE account_key=$1 FOR SHARE',
          [config.accountKey],
        )
      ).rows[0];
      const buyerSource = input[REVIEWED_BUYER] ?? null;
      if (buyerSource) {
        if (!olistBuyerRegistrationEmpty(buyer?.registration))
          throw new OlistError('OLIST_PREVIEW_STALE');
        try {
          assertOlistExistingBuyerSource({
            config,
            customer: { nome: buyer?.name, celular: buyer?.phone },
            buyerSource,
          });
        } catch {
          throw new OlistError('OLIST_PREVIEW_STALE');
        }
      }
      const creationEnabled = Boolean(
        config.configured &&
        config.pilotUserIds?.includes(actor.id) &&
        account?.creation_enabled &&
        !account?.recovery_required &&
        row?.token_envelope &&
        !row?.reconnect_required &&
        !row?.exchange_nonce,
      );
      const paymentDuePolicy = settings?.paymentDuePolicy ?? 'fixed_date';
      const centralFiscal = settings?.productFiscal ?? null;
      const suppliedFiscal = Object.hasOwn(input, 'productFiscal')
        ? olistProductFiscal(input.productFiscal)
        : null;
      if (
        centralFiscal &&
        suppliedFiscal &&
        identityHash(config.hmacKey, 'fiscal-policy', centralFiscal) !==
          identityHash(config.hmacKey, 'fiscal-policy', suppliedFiscal)
      )
        throw new OlistError(
          input[REVIEWED_FISCAL] ? 'OLIST_PREVIEW_STALE' : 'INVALID_REQUEST',
          input[REVIEWED_FISCAL] ? 409 : 400,
        );
      const productFiscal = centralFiscal ?? suppliedFiscal;
      const productFiscalDeferred = productFiscal === null;
      const productFiscalHash = productFiscal
        ? identityHash(config.hmacKey, 'fiscal-policy', productFiscal)
        : null;
      const paymentDueOn =
        paymentDuePolicy === 'erp'
          ? null
          : paymentDuePolicy === 'per_order'
            ? typeof input.paymentDueOn === 'string'
              ? input.paymentDueOn
              : null
            : (settings?.paymentDueOn ?? null);
      const binding = {
        actorId: actor.id,
        authorizationVersion: actor.olistAuthorizationVersion,
        session: input.sessionBinding,
        account: config.accountKey,
        context: config.contextKey,
        connectionVersion: Number(row?.version ?? 0),
        connectionGeneration: Number(row?.generation ?? 0),
        connected,
        settingsVersion: Number(settingsRow?.version ?? 0),
        orderVersion: order.version,
        proposedDay: order.orderDate ? null : operationalDay(clock()),
        sourceRevision: source.sourceRevision,
        buyerVersion,
        paymentDueOn,
        productFiscalHash,
        productFiscalDeferred,
        buyerSourceDigest: buyerSource?.digest ?? null,
        // Hash contents as well as versions: a malformed/stale writer cannot reuse a receipt.
        contents: identityHash(config.hmacKey, 'preview-source', [
          source,
          buyer,
          [buyerContactId, buyerVersion, source.sourceRevision],
          settings,
          resources,
          operation,
          productFiscal,
          productFiscalDeferred,
          buyerSource,
        ]),
      };
      return {
        binding,
        source,
        buyer,
        settings,
        resources,
        operation,
        order: { id: order.id, number: order.number, status: order.status },
        connected,
        creationEnabled:
          creationEnabled && operation?.state !== 'legacy_review_required',
        paymentDuePolicy,
        paymentDueOn,
        productFiscal,
        productFiscalDeferred,
        productFiscalRequired: false,
        buyerSource,
        sourceVersions: {
          contactId: buyerContactId,
          contactVersion: buyerVersion,
          sourceRevision: source.sourceRevision,
        },
      };
    };
    return input.transaction
      ? work(input.transaction)
      : database.transaction(work);
  }
  /** @param {any} input */
  function entity(input) {
    return identityHash(config.hmacKey, 'preview-entity', [
      input.actor.id,
      input.sessionBinding,
      input.orderId,
    ]);
  }
  /** @param {any} value */
  function fingerprint(value) {
    return identityHash(config.hmacKey, 'preview-binding', value);
  }
  return Object.freeze({
    /** @param {any} input */
    async preview(input) {
      const startedAt = clock();
      let reviewedInput = input;
      let before = await snapshot(input);
      if (before.operation?.state === 'legacy_review_required')
        throw new OlistError('OLIST_LEGACY_REVIEW_REQUIRED');
      const buildPlan = (/** @type {any} */ current) =>
        buildOlistPreviewPlan({
          source: current.source,
          buyer: current.buyer,
          settings: current.settings,
          now: startedAt,
          paymentDueOn: input.paymentDueOn,
          buyerSource: current.buyerSource,
        });
      let plan = buildPlan(before);
      const canResolveBuyer = (
        /** @type {any} */ current,
        /** @type {any} */ candidate,
      ) =>
        olistBuyerRegistrationEmpty(current.buyer?.registration) &&
        typeof current.buyer?.name === 'string' &&
        current.buyer.name.trim().length >= 2 &&
        normalizeContactPhone(current.buyer?.phone) &&
        candidate.issues.every(
          (/** @type {any} */ entry) =>
            entry.field.startsWith('buyer.registration.') ||
            entry.field === 'buyer.email',
        );
      const preparationIssues = [];
      let httpReads = 0;
      const client = createOlistClient({
        credentials: () => connection.credentials(input, 'olist.export'),
        quota: connection.quota,
        readWait: olistReadWait('api'),
        fetch: async (url, init) => {
          if ((init?.method ?? 'GET') !== 'GET' || ++httpReads > 64)
            throw new OlistError('OLIST_INCOMPLETE_LOOKUP', 409);
          return (options.fetch ?? globalThis.fetch)(url, init);
        },
        timeoutMs: options.timeoutMs,
        onAuthFailure: (version) => connection.authFailure(input, version),
      });
      // A normal token refresh changes the connection version. Prepare it
      // before capturing the receipt's source, rather than making this preview
      // stale through its own first GET. No entity/sale effect happens here.
      if (
        (plan.issues.length === 0 || canResolveBuyer(before, plan)) &&
        before.connected
      ) {
        try {
          await connection.credentials(input, 'olist.export');
        } catch (error) {
          const candidate = /** @type {any} */ (error);
          if (!SAFE_LOOKUP_ERRORS.has(candidate.code)) throw error;
          preparationIssues.push({ code: candidate.code, field: 'connection' });
        }
        before = await snapshot(input);
        plan = buildPlan(before);
        if (preparationIssues.length === 0 && canResolveBuyer(before, plan)) {
          try {
            const captured = await resolveOlistExistingBuyer({
              client,
              config,
              buyer: before.buyer,
            });
            reviewedInput = {
              ...input,
              [REVIEWED_BUYER]: captured.buyerSource,
            };
            before = await snapshot(reviewedInput);
            plan = buildPlan(before);
          } catch (error) {
            const code = /** @type {any} */ (error).code;
            if (
              !SAFE_LOOKUP_ERRORS.has(code) &&
              ![
                'OLIST_CUSTOMER_NOT_FOUND',
                'OLIST_CUSTOMER_DIVERGENT',
              ].includes(code)
            )
              throw error;
            preparationIssues.push({ code, field: 'buyer.source' });
          }
        }
      }
      if (
        before.binding.proposedDay &&
        plan.commercial.orderDate &&
        before.binding.proposedDay !== plan.commercial.orderDate
      )
        throw new OlistError('OLIST_PREVIEW_STALE', 409);
      const issues = [...plan.issues, ...preparationIssues];
      plan.productFiscal = before.productFiscal;
      plan.productFiscalDeferred = before.productFiscalDeferred;
      if (!before.connected && preparationIssues.length === 0)
        issues.push({ code: 'OLIST_RECONNECT_REQUIRED', field: 'connection' });
      if (before.operation)
        issues.push({
          code:
            before.operation.state === 'legacy_review_required'
              ? 'OLIST_LEGACY_REVIEW_REQUIRED'
              : 'OLIST_OPERATION_EXISTS',
          field: 'operation',
        });
      if (before.resources.length > 1000)
        issues.push({ code: 'OLIST_INCOMPLETE_LOOKUP', field: 'resources' });
      let registrations = null;
      if (issues.length === 0) {
        try {
          for (const [field, kind] of [
            ['sellerId', 'sellers'],
            ['warehouseId', 'warehouses'],
            ['paymentMethodId', 'paymentMethods'],
            ['priceListId', 'priceLists'],
            ['receivingMethodId', 'receivingMethods'],
          ]) {
            if (
              before.settings.paymentDuePolicy === 'erp' &&
              ['paymentMethodId', 'receivingMethodId'].includes(field)
            )
              continue;
            if (
              before.settings[field] !== null &&
              before.settings[field] !== undefined
            ) {
              const candidates = await client.catalog(kind);
              if (
                !candidates.some(
                  (candidate) => candidate.id === before.settings[field],
                )
              )
                issues.push({
                  code: 'OLIST_SETTINGS_REMOTE_MISSING',
                  field: 'settings.' + field,
                });
            }
          }
          registrations = await planOlistResources({
            client,
            config,
            plan,
            resources: before.resources,
          });
          issues.push(...registrations.issues);
        } catch (error) {
          const candidate = /** @type {any} */ (error);
          if (!SAFE_LOOKUP_ERRORS.has(candidate.code)) throw error;
          issues.push({ code: candidate.code, field: 'resources' });
        }
      }
      const after = await snapshot(reviewedInput);
      if (fingerprint(before.binding) !== fingerprint(after.binding))
        throw new OlistError('OLIST_PREVIEW_STALE', 409);
      const expiresAt = new Date(startedAt.getTime() + TTL).toISOString();
      if (clock().getTime() >= Date.parse(expiresAt))
        throw new OlistError('OLIST_PREVIEW_EXPIRED', 409);
      let eligible = issues.length === 0;
      const receipt = eligible
        ? seal(
            {
              binding: before.binding,
              createdAt: startedAt.toISOString(),
              expiresAt,
              commercial: plan.commercial,
              customer: plan.customer,
              buyerSource: plan.buyerSource ?? null,
              settings: before.settings,
              productFiscal: plan.productFiscal,
              productFiscalDeferred: before.productFiscalDeferred,
              policy: 'exact-cent-v1',
              sourceVersions: before.sourceVersions,
              registrations,
            },
            config.envelopeKey,
            'preview',
            config.accountKey,
            entity(input),
          )
        : null;
      let previewToken = receipt
        ? Buffer.from(JSON.stringify(receipt)).toString('base64url')
        : null;
      if (previewToken && previewToken.length > 262144) {
        issues.push({ code: 'OLIST_PREVIEW_TOO_LARGE', field: 'source' });
        eligible = false;
        previewToken = null;
      }
      return {
        orderId: before.order.id,
        number: before.order.number,
        status: before.order.status,
        eligible,
        creationEnabled: before.creationEnabled,
        paymentDuePolicy: before.paymentDuePolicy,
        productFiscal: before.productFiscal,
        productFiscalRequired: before.productFiscalRequired,
        productFiscalDeferred: before.productFiscalDeferred,
        buyerSource: plan.buyerSource
          ? { mode: plan.buyerSource.mode, remoteId: plan.buyerSource.remoteId }
          : null,
        issues,
        commercial: plan.commercial,
        customer: plan.customer
          ? {
              name: plan.customer.nome,
              documentSuffix:
                typeof plan.customer.cpfCnpj === 'string'
                  ? plan.customer.cpfCnpj.slice(-4)
                  : null,
            }
          : null,
        registrations,
        versions: {
          order: before.binding.orderVersion,
          source: before.binding.sourceRevision,
          buyer: before.binding.buyerVersion,
          settings: before.binding.settingsVersion,
          connection: before.binding.connectionVersion,
          authorization: before.binding.authorizationVersion,
        },
        expiresAt: eligible ? expiresAt : null,
        previewToken,
      };
    },
    // Server-only administration reads share the source fence, not export authority.
    snapshotForAdministration: (/** @type {any} */ input) =>
      snapshot(input, 'olist.link', false),
    // Server-only reader: the caller has already locked current authority.
    readReceipt,
    assertFreshReceipt,
    /** Re-read current authority and all local versions; no remote call or reservation.
     * @param {any} input */
    async checkPreview(input) {
      // Preserve current ACL/order checks before opening any stored receipt.
      const initial = await snapshot(input);
      const receipt = readReceipt(input);
      const source = receiptSource(input, receipt);
      const current = source === input ? initial : await snapshot(source);
      validateFresh(current, receipt);
      return {
        valid: true,
        creationEnabled: current.creationEnabled,
        expiresAt: receipt.expiresAt,
      };
    },
  });
  /** @param {any} input */
  function readReceipt(input) {
    if (
      typeof input.previewToken !== 'string' ||
      input.previewToken.length > 262144 ||
      !/^[A-Za-z0-9_-]+$/u.test(input.previewToken)
    )
      throw new OlistError('INVALID_REQUEST', 400);
    let receipt;
    try {
      receipt = open(
        JSON.parse(
          Buffer.from(input.previewToken, 'base64url').toString('utf8'),
        ),
        config.envelopeKey,
        'preview',
        config.accountKey,
        entity(input),
      );
    } catch {
      throw new OlistError('OLIST_PREVIEW_INVALID', 409);
    }
    const issued = Date.parse(receipt.createdAt),
      expires = Date.parse(receipt.expiresAt);
    if (
      !Number.isFinite(issued) ||
      !Number.isFinite(expires) ||
      expires - issued !== TTL ||
      issued > clock().getTime() ||
      receipt.binding?.account !== config.accountKey ||
      receipt.binding?.context !== config.contextKey
    )
      throw new OlistError('OLIST_PREVIEW_INVALID', 409);
    return receipt;
  }
  /** A receipt owns its chosen due day. Commands cannot replace it later.
   * @param {any} input @param {any} receipt */
  function receiptSource(input, receipt) {
    if (
      Object.hasOwn(input, 'paymentDueOn') ||
      Object.hasOwn(input, 'productFiscal') ||
      Object.hasOwn(input, 'buyerSource') ||
      Object.hasOwn(input, 'productFiscalDeferred')
    )
      throw new OlistError('INVALID_REQUEST', 400);
    let source = input;
    if (receipt.buyerSource) {
      assertOlistExistingBuyerSource({
        config,
        customer: receipt.customer,
        buyerSource: receipt.buyerSource,
      });
      if (receipt.binding.buyerSourceDigest !== receipt.buyerSource.digest)
        throw new OlistError('OLIST_PREVIEW_INVALID');
      source = { ...source, [REVIEWED_BUYER]: receipt.buyerSource };
    }
    if (
      (receipt.settings?.productFiscal === null ||
        receipt.settings?.productFiscal === undefined) &&
      receipt.productFiscal !== null &&
      receipt.productFiscal !== undefined
    ) {
      const productFiscal = olistProductFiscal(receipt.productFiscal);
      if (
        receipt.binding.productFiscalHash !==
        identityHash(config.hmacKey, 'fiscal-policy', productFiscal)
      )
        throw new OlistError('OLIST_PREVIEW_INVALID', 409);
      source = { ...source, productFiscal, [REVIEWED_FISCAL]: true };
    }
    if (receipt.settings?.paymentDuePolicy !== 'per_order') return source;
    const due = receipt.commercial?.paymentDueOn;
    if (
      typeof due !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(due) ||
      !Number.isFinite(Date.parse(due + 'T00:00:00Z')) ||
      new Date(due + 'T00:00:00Z').toISOString().slice(0, 10) !== due ||
      receipt.binding?.paymentDueOn !== due
    )
      throw new OlistError('OLIST_PREVIEW_INVALID', 409);
    return { ...source, paymentDueOn: due };
  }
  /** @param {any} current @param {any} receipt */
  function validateFresh(current, receipt) {
    if (clock().getTime() >= Date.parse(receipt.expiresAt))
      throw new OlistError('OLIST_PREVIEW_EXPIRED', 409);
    if (
      fingerprint(current.binding) !== fingerprint(receipt.binding) ||
      fingerprint(current.sourceVersions) !==
        fingerprint(receipt.sourceVersions)
    )
      throw new OlistError('OLIST_PREVIEW_STALE', 409);
  }
  /** Inside the export command's transaction: no HTTP or separate connection.
   * @param {any} input @param {any} receipt */
  async function assertFreshReceipt(input, receipt) {
    const current = await snapshot(receiptSource(input, receipt));
    validateFresh(current, receipt);
    return current;
  }
}
