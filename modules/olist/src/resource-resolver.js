import { OlistError } from './errors.js';
import { olistProductFiscal } from './configuration.js';
import { olistResourceIdentityHash } from './repository.js';
import {
  assertOlistExistingBuyerSource,
  verifyOlistExistingBuyer,
} from './existing-buyer.js';
import {
  buildCustomerPayload,
  buildProductPayload,
  buildVariationPayload,
  productDescription,
} from './resource-payloads.js';

/** Confirmation reads made while an unresolved durable ticket exists (just
 * created, or an earlier reserved/uncertain attempt being recovered) use the patient wait profile of the client:
 * failing them for quota would turn a known effect into an uncertain one.
 * Before any ticket the client's ordinary read profile applies. */
const PATIENT = Object.freeze({ patient: true });
/** @param {any} row */
const ticketed = (row) =>
  ['reserved', 'uncertain'].includes(row?.latestAttempt?.outcome)
    ? PATIENT
    : undefined;
/** Read deduplication scoped to ONE `resolve()` call. The same customer detail,
 * parent product and variation detail are otherwise read again and again by the
 * confirmation steps of a single execution, which on a large order spends the
 * whole provider window before the sale can reserve its own quota. Rules:
 * - only plain reads (no ticket in hand) are served from here; the first read of
 *   each entity still goes to the ERP and is verified against the local link,
 *   and a repeat is verified again on its own (copied) value;
 * - a read made with a durable ticket (`patient`) is a confirmation of an
 *   effect: it always goes to the network and never reads or fills the cache;
 * - after any POST the entries of that resource family are dropped, and the
 *   readbacks of that POST use the client directly, never this object;
 * - only successful, non-empty results are kept (errors and "not found" are
 *   read again), as a private copy, and a hit returns another copy;
 * - searches by reference or document are never cached here.
 * The object lives and dies with its `resolve()` call: no process-wide, job-wide
 * or cross-execution memory.
 * @param {any} client */
export function createOlistExecutionReads(client) {
  /** @type {Map<string,any>} */
  const entries = new Map();
  /** @param {'contact'|'product'} method @param {number} id @param {{patient?:boolean}} [opts] */
  async function read(method, id, opts) {
    if (opts?.patient === true) return client[method](id, opts);
    const key = method + ':' + String(id);
    if (entries.has(key)) return structuredClone(entries.get(key));
    const value = await client[method](id, opts);
    if (value !== null && value !== undefined)
      try {
        entries.set(key, structuredClone(value));
      } catch {
        /* Not copyable: never cached. */
      }
    return value;
  }
  return {
    /** @param {number} id @param {{patient?:boolean}} [opts] */
    contact: (id, opts) => read('contact', id, opts),
    /** @param {number} id @param {{patient?:boolean}} [opts] */
    product: (id, opts) => read('product', id, opts),
    /** A POST of this kind may have changed what the ERP answers.
     * @param {'contact'|'product'} method */
    invalidate(method) {
      for (const key of [...entries.keys()])
        if (key.startsWith(method + ':')) entries.delete(key);
    },
  };
}
/** @param {any} value */
const normalized = (value) =>
  String(value ?? '')
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase('pt-BR');
/** @param {unknown} value */
function remoteNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new OlistError('OLIST_RESOURCE_DIVERGENT');
  return number;
}
/** @param {any} found @param {any} expected */
export function verifyCustomer(found, expected) {
  if (
    !found ||
    remoteNumber(found.id) < 1 ||
    found.situacao !== 'B' ||
    found.tipoPessoa !== expected.tipoPessoa ||
    String(found.cpfCnpj).replace(/[.\-/\s]/gu, '') !== expected.cpfCnpj
  )
    throw new OlistError('OLIST_CUSTOMER_DIVERGENT');
  for (const field of ['nome', 'inscricaoEstadual'])
    if (
      expected[field] !== undefined &&
      normalized(found[field]) !== normalized(expected[field])
    )
      throw new OlistError('OLIST_CUSTOMER_DIVERGENT');
  for (const field of [
    'cep',
    'municipio',
    'uf',
    'endereco',
    'bairro',
    'numero',
    'complemento',
  ]) {
    const actual = found.endereco?.[field],
      desired = expected.endereco[field];
    if (
      field === 'cep'
        ? String(actual ?? '').replace(/[^0-9]/gu, '') !== String(desired)
        : normalized(actual) !== normalized(desired)
    )
      throw new OlistError('OLIST_CUSTOMER_DIVERGENT');
  }
  return found;
}
/** @param {any} found @param {any} node @param {any} fiscal */
export function verifyProduct(found, node, fiscal) {
  // A legacy SKU is accepted only when the administrative link froze that
  // exact value for this confirmed remote ID. Older links and uncertain effects
  // retain deterministic references; a later SKU edit is always divergent.
  const confirmedIdentity =
    node.row.state === 'confirmed' &&
    node.row.remote_id !== null &&
    node.row.remote_id !== undefined &&
    String(node.row.remote_id) === String(found?.id);
  const expectedSku =
    confirmedIdentity &&
    node.row.verified_remote_sku !== null &&
    node.row.verified_remote_sku !== undefined
      ? node.row.verified_remote_sku
      : node.row.reference;
  const validExpectedSku =
    typeof expectedSku === 'string' &&
    expectedSku.trim() !== '' &&
    expectedSku.length <= 100 &&
    !/[\u0000-\u001f\u007f]/u.test(expectedSku);
  if (
    !found ||
    remoteNumber(found.id) < 1 ||
    found.tipo !== 'V' ||
    found.situacao !== 'A' ||
    !validExpectedSku ||
    found.sku !== expectedSku ||
    normalized(found.descricao) !==
      normalized(productDescription(node.attributes)) ||
    !Array.isArray(found.variacoes)
  )
    throw new OlistError('OLIST_PRODUCT_DIVERGENT');
  if (
    fiscal &&
    (String(found.ncm ?? '').replace(/[.\s]/gu, '') !== fiscal.ncm ||
      !(
        (typeof found.origem === 'number' &&
          Number.isInteger(found.origem) &&
          found.origem >= 0 &&
          found.origem <= 8) ||
        (typeof found.origem === 'string' && /^[0-8]$/u.test(found.origem))
      ) ||
      Number(found.origem) !== fiscal.origin ||
      normalized(found.unidade) !== normalized(fiscal.unit))
  )
    throw new OlistError('OLIST_PRODUCT_FISCAL_DIVERGENT');
  return found;
}
/** Match both the parent grade and an independent child detail. A pending,
 * never-dispatched size may reuse a unique existing SKU. An uncertain effect
 * requires its own deterministic SKU; zero never permits a new POST.
 * @param {any} parent @param {any} child @param {boolean} strict */
export function childCandidate(parent, child, strict) {
  const matches = parent.variacoes.filter(
    (/** @type {any} */ value) =>
      Array.isArray(value.grade) &&
      value.grade.length === 1 &&
      normalized(value.grade[0].chave) === 'tamanho' &&
      normalized(value.grade[0].valor) === normalized(child.size),
  );
  if (matches.length > 1) throw new OlistError('OLIST_AMBIGUOUS_MATCH');
  const found = matches[0] ?? null;
  if (
    found &&
    (typeof found.sku !== 'string' ||
      (strict && found.sku !== child.row.reference))
  )
    throw new OlistError('OLIST_VARIATION_DIVERGENT');
  return found;
}
/** Server-only T22 orchestration. The persisted export is the sole source;
 * callers provide no commercial payload. Production has no creator route or
 * generic write port. The T08 worker composes it internally; tickets, not
 * retries or leases, own effects.
 * @param {{repository:any,client:any,writer:any,config:{accountKey:string,contextKey:string,hmacKey:Buffer},onStage?:(stage:string)=>Promise<unknown>}} options */
export function createOlistResourceResolver({
  repository,
  client,
  writer,
  config,
  onStage,
}) {
  /** @param {any} input */
  async function resolve(input) {
    const reads = createOlistExecutionReads(client);
    const operation = await repository.readExport({
      ...input,
      accountKey: config.accountKey,
      contextKey: config.contextKey,
    });
    const plan = operation.snapshot;
    const versions = plan?.sourceVersions;
    if (
      plan?.policy !== 'exact-cent-v1' ||
      !versions ||
      !Number.isSafeInteger(versions.sourceRevision) ||
      versions.sourceRevision < 0 ||
      (versions.contactId !== null &&
        (typeof versions.contactId !== 'string' ||
          !Number.isSafeInteger(versions.contactVersion) ||
          versions.contactVersion < 1))
    )
      throw new OlistError('OLIST_RESOURCE_PLAN_INVALID', 400);
    const base = {
      ...input,
      accountKey: config.accountKey,
      contextKey: config.contextKey,
      settingsVersion: Number(operation.settings_version),
    };
    const existingBuyer = plan.buyerSource?.mode === 'erp-existing-v1';
    if (plan.buyerSource && !existingBuyer)
      throw new OlistError('OLIST_RESOURCE_PLAN_INVALID', 400);
    if (existingBuyer)
      assertOlistExistingBuyerSource({
        config,
        customer: plan.customer,
        buyerSource: plan.buyerSource,
      });
    const customer = existingBuyer
      ? plan.customer
      : buildCustomerPayload(plan.customer, 'CRM-customer');
    const fiscal =
      plan.productFiscal === null || plan.productFiscal === undefined
        ? null
        : olistProductFiscal(plan.productFiscal);
    if (
      !Array.isArray(plan.commercial?.groups) ||
      !plan.commercial.groups.length ||
      plan.commercial.groups.length > 50
    )
      throw new OlistError('OLIST_RESOURCE_PLAN_INVALID', 400);
    const uuid =
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
    const ids = new Set();
    /** @type {Map<string,Set<string>>} */
    const parentSizes = new Map();
    let total = 0n;
    // Complete preflight runs before even a local resource binding or buyer POST.
    for (const group of plan.commercial.groups) {
      productDescription(group.attributes);
      if (
        typeof group.groupId !== 'string' ||
        !uuid.test(group.groupId) ||
        ids.has(group.groupId) ||
        !Array.isArray(group.lines) ||
        !group.lines.length ||
        group.lines.length > 100
      )
        throw new OlistError('OLIST_RESOURCE_PLAN_INVALID', 400);
      ids.add(group.groupId);
      const groupIdentity = olistResourceIdentityHash(config.hmacKey, {
        accountKey: config.accountKey,
        kind: 'product',
        identity: group.attributes,
      });
      const combinedSizes = parentSizes.get(groupIdentity) ?? new Set();
      parentSizes.set(groupIdentity, combinedSizes);
      const sizes = new Set();
      for (const line of group.lines) {
        if (
          typeof line.lineId !== 'string' ||
          !uuid.test(line.lineId) ||
          ids.has(line.lineId) ||
          line.groupId !== group.groupId ||
          !Number.isSafeInteger(line.quantity) ||
          line.quantity <= 0 ||
          !Number.isSafeInteger(line.subtotalCents) ||
          line.subtotalCents <= 0 ||
          !Number.isSafeInteger(line.unitCents) ||
          line.unitCents <= 0 ||
          BigInt(line.quantity) * BigInt(line.unitCents) !==
            BigInt(line.subtotalCents)
        )
          throw new OlistError('OLIST_RESOURCE_PLAN_INVALID', 400);
        const cents = BigInt(line.unitCents);
        if (
          line.unitLexeme !==
          `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
        )
          throw new OlistError('OLIST_RESOURCE_PLAN_INVALID', 400);
        buildVariationPayload({ size: line.size, sku: 'CRM-preflight' });
        if (sizes.has(normalized(line.size)))
          throw new OlistError('OLIST_RESOURCE_PLAN_INVALID', 400);
        sizes.add(normalized(line.size));
        combinedSizes.add(normalized(line.size));
        if (combinedSizes.size > 100)
          throw new OlistError('OLIST_RESOURCE_BATCH_LIMIT', 400);
        ids.add(line.lineId);
        total += BigInt(line.subtotalCents);
      }
      if (fiscal || plan.productFiscalDeferred === true)
        buildProductPayload({
          attributes: group.attributes,
          sku: 'CRM-preflight',
          fiscal,
          variations: group.lines.map(
            (/** @type {any} */ line, /** @type {number} */ i) => ({
              size: line.size,
              sku: 'CRM-preflight-' + i,
            }),
          ),
        });
    }
    if (
      !Number.isSafeInteger(plan.commercial.totalCents) ||
      total > BigInt(Number.MAX_SAFE_INTEGER) ||
      total !== BigInt(plan.commercial.totalCents)
    )
      throw new OlistError('OLIST_RESOURCE_PLAN_INVALID', 400);
    /** @param {any} row */
    const current = (row) =>
      repository.readResource({ ...base, resourceId: row.id });
    /** @param {any} row @param {string|number} id */
    async function bindFound(row, id) {
      row = await current(row);
      if (row.state === 'confirmed') {
        if (String(row.remote_id) !== String(id))
          throw new OlistError('OLIST_RESOURCE_DIVERGENT');
        return row;
      }
      const method =
        row.latestAttempt || ['reserved', 'uncertain'].includes(row.state)
          ? 'reconcileResourceLookup'
          : 'confirmResourceLookup';
      return repository[method]({
        ...base,
        resourceId: row.id,
        expectedVersion: Number(row.version),
        remoteId: String(id),
      });
    }
    /** @param {any} reservation */
    async function uncertain(reservation) {
      if (!reservation) return;
      const results = [
        {
          attemptId: reservation.attemptId,
          fence: reservation.fence,
          outcome: 'uncertain',
        },
        ...(reservation.children ?? []).map((/** @type {any} */ ticket) => ({
          attemptId: ticket.attemptId,
          fence: ticket.fence,
          outcome: 'uncertain',
        })),
      ];
      try {
        await repository.recordResourceBatchResult({ ...base, results });
      } catch {
        throw new OlistError('OLIST_RESOURCE_PERSISTENCE_FAILED', 503);
      }
    }
    /** @param {any} row @param {string} kind @param {any} payload @param {any[]} children @param {number|undefined} [parentRemoteId] */
    async function dispatch(row, kind, payload, children = [], parentRemoteId) {
      row = await current(row);
      if (row.state !== 'pending' || row.latestAttempt)
        throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
      let reservation;
      try {
        /** @type {any} */ let response;
        try {
          // Read before the writer takes credentials/write quota. A GET inside
          // its reservation callback could refresh those credentials or spend
          // the headroom already claimed for the POST's confirmation reads.
          if (existingBuyer)
            await verifyOlistExistingBuyer({
              client,
              config,
              customer,
              buyerSource: plan.buyerSource,
            });
          response = await writer.dispatch({
            kind,
            payload,
            parentRemoteId,
            reserve: async (
              /** @type {any} */ requestPayload,
              /** @type {any} */ credentials,
            ) => {
              reservation = await repository.reserveResourceEffect({
                ...base,
                resourceId: row.id,
                expectedVersion: Number(row.version),
                connectionVersion: credentials.connectionVersion,
                dependentResourceIds: children.map((child) => child.id),
                requestPayload,
              });
              return reservation;
            },
          });
        } finally {
          // The POST may have changed the ERP, even when its answer was lost.
          reads.invalidate(kind === 'customer' ? 'contact' : 'product');
        }
        // Persist an observed ID before any follow-up read, including the parent
        // ID returned by the provider's variation endpoint.
        await repository.recordObservedResourceId({
          ...base,
          ...response.reservation,
          remoteId: response.remoteId,
        });
        if (response.quotaObservationFailed) {
          await uncertain(response.reservation);
          throw new OlistError('OLIST_RESOURCE_UNCERTAIN');
        }
        return response;
      } catch (error) {
        const failure = /** @type {any} */ (error);
        const ticket = failure.reservation ?? reservation;
        if (ticket) await uncertain(ticket);
        if (ticket) throw new OlistError('OLIST_RESOURCE_UNCERTAIN');
        throw error;
      }
    }
    /** @param {any} row @param {string|number} id @param {any} [ticket] */
    async function finish(row, id, ticket) {
      if (ticket) {
        await repository.recordResult({
          ...base,
          attemptId: ticket.attemptId,
          fence: ticket.fence,
          outcome: 'confirmed',
          remoteId: String(id),
          response: { id: String(id) },
        });
        return { ...row, state: 'confirmed', remote_id: String(id) };
      }
      row = await current(row);
      if (row.latestAttempt?.outcome === 'reserved') {
        await repository.recordResult({
          ...base,
          attemptId: row.latestAttempt.id,
          fence: row.latestAttempt.fence,
          outcome: 'confirmed',
          remoteId: String(id),
          response: { id: String(id) },
        });
        return current(row);
      }
      return bindFound(row, id);
    }
    /** @param {string} method @param {any} identity @param {{patient:boolean}} [opts] */
    async function find(method, identity, opts) {
      return (client[method + 'AcrossStates'] ?? client[method]).call(
        client,
        identity,
        opts,
      );
    }
    let buyerRow = existingBuyer
      ? null
      : await repository.bindResource({
          ...base,
          kind: 'customer',
          identity: customer.cpfCnpj,
          payload: customer,
        });
    /** @type {Map<string,any>} */
    const nodes = new Map();
    /** @type {any[]} */
    const groups = [];
    for (const group of plan.commercial.groups) {
      const attributes = Object.fromEntries(
        Object.entries(group.attributes).map(([key, value]) => [
          key,
          normalized(value),
        ]),
      );
      const identity = olistResourceIdentityHash(config.hmacKey, {
        accountKey: config.accountKey,
        kind: 'product',
        identity: attributes,
      });
      let node = nodes.get(identity);
      if (!node) {
        const row = await repository.bindResource({
          ...base,
          kind: 'product',
          identity: attributes,
          payload: { attributes, fiscal },
        });
        node = { row, attributes, children: new Map(), remote: null };
        nodes.set(identity, node);
      }
      const mappings = [];
      for (const line of group.lines) {
        let child = node.children.get(normalized(line.size));
        if (!child) {
          const row = await repository.bindResource({
            ...base,
            kind: 'variation',
            parentId: node.row.id,
            identity: normalized(line.size),
            payload: { size: normalized(line.size) },
          });
          child = { row, size: line.size };
          node.children.set(normalized(line.size), child);
        }
        mappings.push({ lineId: line.lineId, child });
      }
      groups.push({ groupId: group.groupId, node, mappings });
    }
    /** @param {any} row */
    function observed(row) {
      return row.remote_id ?? row.latestAttempt?.observed_remote_id ?? null;
    }
    /** @param {any} row */
    function canCreate(row) {
      return row.state === 'pending' && !row.latestAttempt;
    }
    if (existingBuyer)
      await verifyOlistExistingBuyer({
        client,
        config,
        customer,
        buyerSource: plan.buyerSource,
      });
    else buyerRow = await current(buyerRow);
    let buyerRemote = existingBuyer
      ? { id: Number(plan.buyerSource.remoteId) }
      : observed(buyerRow)
        ? await reads.contact(
            remoteNumber(observed(buyerRow)),
            ticketed(buyerRow),
          )
        : await find('findCustomer', customer.cpfCnpj, ticketed(buyerRow));
    if (buyerRemote && !existingBuyer)
      buyerRemote = verifyCustomer(
        await reads.contact(remoteNumber(buyerRemote.id), ticketed(buyerRow)),
        customer,
      );
    if (!buyerRemote && !canCreate(buyerRow))
      throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
    // Discover all parent requirements before the first buyer inclusion. A
    // missing fiscal policy or ambiguous parent cannot leave a partial buyer.
    for (const node of nodes.values()) {
      node.row = await current(node.row);
      const candidate = observed(node.row)
        ? { id: observed(node.row) }
        : await find('findProduct', node.row.reference, ticketed(node.row));
      if (candidate)
        node.remote = verifyProduct(
          await reads.product(remoteNumber(candidate.id), ticketed(node.row)),
          node,
          fiscal,
        );
      if (!node.remote && !canCreate(node.row))
        throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
      if (!node.remote && !fiscal && plan.productFiscalDeferred !== true)
        throw new OlistError('OLIST_PRODUCT_FISCAL_REQUIRED');
      if (node.remote)
        for (const child of node.children.values())
          childCandidate(node.remote, child, Boolean(child.row.latestAttempt));
    }
    await onStage?.('customer');
    if (!buyerRemote) {
      const response = await dispatch(
        buyerRow,
        'customer',
        buildCustomerPayload(customer, buyerRow.reference),
        [],
      );
      try {
        buyerRemote = verifyCustomer(
          await client.contact(remoteNumber(response.remoteId), PATIENT),
          customer,
        );
        buyerRow = await finish(buyerRow, buyerRemote.id, response.reservation);
      } catch (error) {
        await uncertain(response.reservation);
        throw error;
      }
    } else if (!existingBuyer)
      buyerRow = await bindFound(buyerRow, buyerRemote.id);
    await onStage?.('product');
    for (const node of nodes.values()) {
      if (!node.remote) {
        const children = [...node.children.values()];
        const payload = buildProductPayload({
          attributes: node.attributes,
          sku: node.row.reference,
          fiscal,
          variations: children.map((child) => ({
            size: child.size,
            sku: child.row.reference,
          })),
        });
        const response = await dispatch(
          node.row,
          'product',
          payload,
          children.map((child) => child.row),
        );
        try {
          node.remote = verifyProduct(
            await client.product(remoteNumber(response.remoteId), PATIENT),
            node,
            fiscal,
          );
          node.row = await finish(
            node.row,
            node.remote.id,
            response.reservation,
          );
        } catch (error) {
          await uncertain(response.reservation);
          throw error;
        }
      } else node.row = await bindFound(node.row, node.remote.id);
      await onStage?.('variation');
      for (const child of node.children.values()) {
        child.row = await current(child.row);
        const parentId = remoteNumber(node.row.remote_id);
        let response = null;
        try {
          let parent = verifyProduct(
            await reads.product(parentId, ticketed(child.row)),
            node,
            fiscal,
          );
          let found = childCandidate(
            parent,
            child,
            Boolean(child.row.latestAttempt),
          );
          if (!found) {
            if (!canCreate(child.row)) {
              if (child.row.latestAttempt?.outcome === 'reserved')
                await uncertain({
                  attemptId: child.row.latestAttempt.id,
                  fence: child.row.latestAttempt.fence,
                });
              throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
            }
            response = await dispatch(
              child.row,
              'variation',
              buildVariationPayload({
                size: child.size,
                sku: child.row.reference,
              }),
              [],
              parentId,
            );
          }
          if (response) {
            parent = verifyProduct(
              await client.product(parentId, PATIENT),
              node,
              fiscal,
            );
            found = childCandidate(parent, child, true);
          }
          if (!found) throw new OlistError('OLIST_RESOURCE_UNCERTAIN');
          const id = remoteNumber(found.id);
          if (
            !child.row.latestAttempt?.observed_remote_id &&
            child.row.latestAttempt?.outcome === 'reserved'
          )
            await repository.recordObservedResourceId({
              ...base,
              attemptId: child.row.latestAttempt.id,
              fence: child.row.latestAttempt.fence,
              remoteId: String(id),
            });
          const detail = response
            ? await client.product(id, PATIENT)
            : await reads.product(id, ticketed(child.row));
          if (
            detail.id !== id ||
            detail.produtoPai?.id !== parentId ||
            detail.tipoVariacao !== 'V' ||
            detail.situacao !== 'A' ||
            detail.sku !== found.sku
          )
            throw new OlistError('OLIST_VARIATION_DIVERGENT');
          child.row = await finish(
            child.row,
            id,
            response?.reservation ??
              (child.row.latestAttempt?.outcome === 'reserved'
                ? {
                    attemptId: child.row.latestAttempt.id,
                    fence: child.row.latestAttempt.fence,
                  }
                : undefined),
          );
        } catch (error) {
          if (response) await uncertain(response.reservation);
          else if (child.row.latestAttempt?.outcome === 'reserved')
            await uncertain({
              attemptId: child.row.latestAttempt.id,
              fence: child.row.latestAttempt.fence,
            });
          throw error;
        }
      }
    }
    return {
      resolved: true,
      customerId: existingBuyer
        ? plan.buyerSource.remoteId
        : String(buyerRow.remote_id),
      groups: groups.map((group) => ({
        groupId: group.groupId,
        productId: String(group.node.row.remote_id),
        lines: group.mappings.map((/** @type {any} */ mapping) => ({
          lineId: mapping.lineId,
          productId: String(mapping.child.row.remote_id),
        })),
      })),
    };
  }
  return Object.freeze({
    resolve: async (/** @type {any} */ input) => {
      try {
        return await resolve(input);
      } catch (error) {
        if (error instanceof OlistError) throw error;
        if (/** @type {any} */ (error)?.code === 'FORBIDDEN')
          throw new OlistError('FORBIDDEN', 403);
        throw new OlistError('OLIST_RESOURCE_UNAVAILABLE', 503);
      }
    },
  });
}
