import { OlistError, text } from './errors.js';
import {
  prepareExactCentExport,
  reconcileExactCentExport,
} from '@crm-silmer/orders';
import { identityHash } from './crypto.js';
import { olistProductFiscal, normalizeDocument } from './configuration.js';
import { buildCustomerPayload } from './resource-payloads.js';
import {
  normalizeContactPhone,
  normalizeContactEmail,
} from '@crm-silmer/contacts';
import {
  verifyCustomer,
  verifyProduct,
  childCandidate,
} from './resource-resolver.js';
import { buildOlistSalePayload, reconcileOlistSale } from './sale-payload.js';
import {
  OlistJsonNumber,
  parseOlistLosslessJson,
  olistIntegerFromJson,
  olistNumberLexeme,
} from './lossless-json.js';

/** @param {string} [code] @returns {never} */
function refuse(code = 'OLIST_SALE_READBACK_MISMATCH') {
  throw new OlistError(code, 409);
}
/** Identity conversion is permitted only for exact, safe positive integers.
 * @param {unknown} value */
function remoteId(value) {
  const raw = String(value);
  if (!/^[1-9][0-9]{0,15}$/u.test(raw)) refuse('OLIST_RESOURCE_DIVERGENT');
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result < 1 || String(result) !== raw)
    refuse('OLIST_RESOURCE_DIVERGENT');
  return result;
}
/** @param {any} value */
function observed(value) {
  return (
    value?.remote_id ??
    value?.latestAttempt?.observed_remote_id ??
    value?.latestAttempt?.observedRemoteId ??
    null
  );
}
/** The remote parser never routes a monetary token through Number.
 * @param {any} value @returns {string} */
function encodeLossless(value) {
  if (value instanceof OlistJsonNumber) return value.lexeme;
  if (Array.isArray(value))
    return '[' + value.map(encodeLossless).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .map((key) => JSON.stringify(key) + ':' + encodeLossless(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
/** Exact monetary token comparison; fractional cents are never rounded.
 * @param {any} value */
function unitCents(value) {
  const raw = olistNumberLexeme(value);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(
    raw,
  );
  if (!match) refuse();
  const exponent = BigInt(match[3] ?? '0');
  if (exponent < -20n || exponent > 20n) refuse();
  const fraction = match[2] ?? '';
  let coefficient = BigInt(match[1] + fraction);
  const power = exponent - BigInt(fraction.length) + 2n;
  if (power >= 0n) coefficient *= 10n ** power;
  else {
    const divisor = 10n ** -power;
    if (coefficient % divisor !== 0n) refuse();
    coefficient /= divisor;
  }
  if (coefficient < 1n) refuse();
  return coefficient;
}
/** @param {any} found @param {any} expected */
function customerMatches(found, expected) {
  verifyCustomer(found, expected);
  if (
    normalizeContactPhone(found.celular) !== expected.celular ||
    (expected.email !== undefined &&
      normalizeContactEmail(found.email) !== expected.email)
  )
    refuse('OLIST_CUSTOMER_DIVERGENT');
  return found;
}
/** @param {any} snapshot @param {string} reference */
function preflight(snapshot, reference) {
  let next = 10;
  return buildOlistSalePayload({
    snapshot,
    reference,
    resolved: {
      resolved: true,
      customerId: '1',
      groups: (snapshot?.commercial?.groups ?? []).map(
        (/** @type {any} */ group) => ({
          groupId: group.groupId,
          productId: String(next++),
          lines: (group.lines ?? []).map((/** @type {any} */ line) => ({
            lineId: line.lineId,
            productId: String(next++),
          })),
        }),
      ),
    },
  });
}
/** A closed read-only inspector. It receives only the fixed GET client; no
 * writer, dispatcher, reservation callback or commercial mutation is present.
 * @param {{client:any,config:{hmacKey:Buffer}}} options */
export function createOlistReadonlyInspector({ client, config }) {
  /** A fresh bounded read scope prevents cross-command caches or evidence.
   * @returns {{read:(method:string,...args:any[])=>Promise<any>, digest:()=>string}} */
  function scope() {
    /** @type {any[]} */ const trail = [];
    let count = 0;
    return {
      async read(method, ...args) {
        if (
          ![
            'contact',
            'product',
            'orderRaw',
            'findOrder',
            'findCustomer',
            'findCustomerAcrossStates',
            'findProduct',
            'findProductAcrossStates',
          ].includes(method) ||
          ++count > 64
        )
          refuse('OLIST_INCOMPLETE_LOOKUP');
        const value = await client[method](...args);
        trail.push([method, args, value]);
        return value;
      },
      digest: () => identityHash(config.hmacKey, 'readonly-evidence', trail),
    };
  }
  /** Explicit, sale-local correspondence. It never establishes a reusable
   * product identity and is never a fallback for a canonical uncertain effect.
   * @param {any} input */
  async function legacyExistingSale({
    snapshot,
    reference,
    remoteId: selectedId,
    mapping,
    paymentDueOn,
  }) {
    if (
      snapshot?.policy !== 'legacy-sale-only-v1' ||
      snapshot?.linkMode !== 'legacy-sale-only-v1' ||
      !/^CRM-[A-Za-z0-9-]{1,100}$/u.test(reference)
    )
      refuse('OLIST_RECONCILIATION_REQUIRED');
    const prepared = prepareExactCentExport(
      snapshot.commercial.groups.map((/** @type {any} */ group) => ({
        id: group.groupId,
        lines: group.lines.map((/** @type {any} */ line) => ({
          id: line.lineId,
          size: line.size,
          quantity: line.quantity,
          subtotalCents: line.subtotalCents,
          subtotalReviewed: true,
        })),
      })),
    );
    if (
      !prepared.eligible ||
      prepared.totalCents !== snapshot.commercial.totalCents
    )
      refuse();
    /** @param {any} value @param {string[]} fields */
    function shape(value, fields) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== fields.length ||
        fields.some((field) => !Object.hasOwn(value, field))
      )
        throw new OlistError('INVALID_REQUEST', 400);
    }
    shape(mapping, ['groups']);
    if (
      !Array.isArray(mapping.groups) ||
      !mapping.groups.length ||
      mapping.groups.length > 50
    )
      throw new OlistError('INVALID_REQUEST', 400);
    const reads = scope(),
      wantedId = remoteId(selectedId);
    const body = parseOlistLosslessJson(await reads.read('orderRaw', wantedId));
    if (
      olistIntegerFromJson(body?.id) !== wantedId ||
      !Array.isArray(body.itens) ||
      !body.itens.length ||
      body.itens.length > 250
    )
      refuse();
    const actualReference = body.ecommerce?.numeroPedidoEcommerce;
    if (
      actualReference !== undefined &&
      actualReference !== null &&
      actualReference !== '' &&
      actualReference !== reference
    )
      refuse('OLIST_SALE_REFERENCE_CONFLICT');
    const customerId = olistIntegerFromJson(body.cliente?.id);
    const customer = await reads.read('contact', customerId);
    if (remoteId(customer?.id) !== customerId)
      refuse('OLIST_CUSTOMER_DIVERGENT');
    customerMatches(
      customer,
      buildCustomerPayload(snapshot.customer, 'CRM-legacy-sale-buyer'),
    );
    if (
      normalizeDocument(body.cliente?.cpfCnpj) !==
      normalizeDocument(snapshot.customer.cpfCnpj)
    )
      refuse('OLIST_CUSTOMER_DIVERGENT');
    /** @type {Map<number,any>} */ const products = new Map();
    /** @param {number} id */
    async function product(id) {
      if (!products.has(id)) products.set(id, await reads.read('product', id));
      const found = products.get(id);
      if (remoteId(found?.id) !== id) refuse('OLIST_PRODUCT_DIVERGENT');
      return found;
    }
    /** @param {unknown} value */
    const normalized = (value) =>
      String(value ?? '')
        .normalize('NFC')
        .trim()
        .toLocaleLowerCase('pt-BR');
    const usedGroups = new Set(),
      usedLines = new Set(),
      usedItems = new Set();
    /** @type {any[]} */ const groups = [],
      correspondence = [],
      fiscalObservations = [];
    for (const group of snapshot.commercial.groups) {
      const supplied = mapping.groups.filter(
        (/** @type {any} */ entry) => entry?.groupId === group.groupId,
      );
      if (supplied.length !== 1 || usedGroups.has(group.groupId))
        refuse('OLIST_RESOURCE_DIVERGENT');
      const selected = supplied[0];
      shape(selected, ['groupId', 'parentProductId', 'lines']);
      if (typeof selected.parentProductId !== 'string')
        throw new OlistError('INVALID_REQUEST', 400);
      if (
        !Array.isArray(selected.lines) ||
        selected.lines.length !== group.lines.length
      )
        refuse('OLIST_RESOURCE_DIVERGENT');
      usedGroups.add(group.groupId);
      const parentId = remoteId(selected.parentProductId),
        parent = await product(parentId);
      if (
        parent.situacao !== 'A' ||
        !(parent.tipo === 'V' || parent.tipoVariacao === 'P') ||
        !Array.isArray(parent.variacoes)
      )
        refuse('OLIST_PRODUCT_DIVERGENT');
      // Historical fiscal fields are observations, never a verified policy or
      // a reusable product identity. This path cannot create a product/order.
      const ncm =
        typeof parent.ncm === 'string' && parent.ncm.trim()
          ? text(parent.ncm, 20)
          : null;
      const unit =
        typeof parent.unidade === 'string' && parent.unidade.trim()
          ? text(parent.unidade, 20)
          : null;
      fiscalObservations.push({
        parentProductId: String(parentId),
        description:
          typeof parent.descricao === 'string'
            ? parent.descricao.slice(0, 12000)
            : null,
        sku: typeof parent.sku === 'string' ? parent.sku.slice(0, 1000) : null,
        ncm,
        unit,
        origin:
          parent.origem === undefined || parent.origem === null
            ? null
            : text(String(parent.origem), 20),
        fiscalMissing: !ncm || !unit,
      });
      const parentChildIds = new Set();
      for (const candidate of parent.variacoes) {
        const id = remoteId(candidate.id);
        if (parentChildIds.has(id)) refuse('OLIST_VARIATION_DIVERGENT');
        parentChildIds.add(id);
      }
      /** @type {any[]} */ const lines = [],
        explicitLines = [];
      for (const line of group.lines) {
        const matches = selected.lines.filter(
          (/** @type {any} */ entry) => entry?.lineId === line.lineId,
        );
        if (matches.length !== 1 || usedLines.has(line.lineId))
          refuse('OLIST_RESOURCE_DIVERGENT');
        const mapped = matches[0];
        shape(mapped, ['lineId', 'childProductId', 'itemIndex']);
        if (typeof mapped.childProductId !== 'string')
          throw new OlistError('INVALID_REQUEST', 400);
        const index = mapped.itemIndex;
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= body.itens.length ||
          usedItems.has(index)
        )
          refuse('OLIST_RESOURCE_DIVERGENT');
        const childId = remoteId(mapped.childProductId),
          child = await product(childId);
        if (
          child.situacao !== 'A' ||
          child.tipoVariacao !== 'V' ||
          remoteId(child.produtoPai?.id) !== parentId ||
          childId === parentId
        )
          refuse('OLIST_VARIATION_DIVERGENT');
        const grade = parent.variacoes.filter(
          (/** @type {any} */ entry) =>
            Array.isArray(entry.grade) &&
            entry.grade.length === 1 &&
            ['tamanho', 'tamanhos'].includes(
              normalized(entry.grade[0].chave),
            ) &&
            normalized(entry.grade[0].valor) === normalized(line.size),
        );
        if (grade.length !== 1 || remoteId(grade[0].id) !== childId)
          refuse('OLIST_VARIATION_DIVERGENT');
        const item = body.itens[index];
        if (
          olistIntegerFromJson(item?.produto?.id) !== childId ||
          (item.infoAdicional !== undefined &&
            item.infoAdicional !== null &&
            item.infoAdicional !== '' &&
            item.infoAdicional !== line.lineId)
        )
          refuse();
        item.infoAdicional = line.lineId;
        usedLines.add(line.lineId);
        usedItems.add(index);
        lines.push({
          lineId: line.lineId,
          productId: String(childId),
          itemIndex: index,
        });
        explicitLines.push({
          lineId: line.lineId,
          childProductId: String(childId),
          itemIndex: index,
        });
      }
      groups.push({
        groupId: group.groupId,
        productId: String(parentId),
        lines,
      });
      correspondence.push({
        groupId: group.groupId,
        parentProductId: String(parentId),
        lines: explicitLines,
      });
    }
    if (
      usedGroups.size !== mapping.groups.length ||
      usedItems.size !== body.itens.length
    )
      refuse('OLIST_RESOURCE_DIVERGENT');
    const resources = {
      resolved: true,
      mode: 'legacy-sale-only-v1',
      customerId: String(customerId),
      groups,
      legacyCorrespondence: { groups: correspondence },
    };
    /** @param {any} value */
    const emptyObject = (value) =>
      value === undefined ||
      value === null ||
      (value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0);
    /** @param {any} value */
    const emptyArray = (value) =>
      value === undefined ||
      value === null ||
      (Array.isArray(value) && value.length === 0);
    /** @param {any} value */
    const zero = (value) =>
      value === undefined ||
      value === null ||
      /^-?0(?:\.0+)?(?:[eE][+-]?[0-9]+)?$/u.test(olistNumberLexeme(value));
    if (
      olistIntegerFromJson(body.situacao, true) !== 0 ||
      !zero(body.idNotaFiscal) ||
      !emptyObject(body.notaFiscal) ||
      !emptyArray(body.pagamentosIntegrados) ||
      ![undefined, null, ''].includes(body.dataFaturamento) ||
      !zero(body.origemPedido) ||
      ![body.valorDesconto, body.valorFrete, body.valorOutrasDespesas].every(
        zero,
      )
    )
      refuse();
    /** Literal day or documented ERP midnight, never an inferred timezone.
     * @param {unknown} value */
    function historicalDay(value) {
      if (
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}(?: 00:00:00)?$/u.test(value)
      )
        refuse();
      const day = value.slice(0, 10),
        date = new Date(day + 'T00:00:00Z');
      if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== day
      )
        refuse();
      return day;
    }
    const orderDate = historicalDay(body.data);
    if (
      snapshot.commercial.orderDate &&
      snapshot.commercial.orderDate !== orderDate
    )
      refuse();
    const deliveryOn =
      body.dataPrevista === undefined ||
      body.dataPrevista === null ||
      body.dataPrevista === ''
        ? null
        : historicalDay(body.dataPrevista);
    if (deliveryOn && deliveryOn !== snapshot.commercial.deliveryOn) refuse();
    const installments = body.pagamento?.parcelas;
    if (
      !Array.isArray(installments) ||
      installments.length !== 1 ||
      !emptyObject(installments[0].transacao) ||
      unitCents(installments[0].valor) !==
        BigInt(snapshot.commercial.totalCents)
    )
      refuse();
    const due = historicalDay(installments[0].data);
    if (paymentDueOn !== undefined && paymentDueOn !== due) refuse();
    let checked;
    try {
      checked = reconcileExactCentExport(prepared, {
        lines: body.itens.map((/** @type {any} */ item) => ({
          lineId: item.infoAdicional,
          quantity: olistIntegerFromJson(item.quantidade),
          unitLexeme: olistNumberLexeme(item.valorUnitario),
        })),
        totalProductsLexeme: olistNumberLexeme(body.valorTotalProdutos),
        totalOrderLexeme: olistNumberLexeme(body.valorTotalPedido),
      });
    } catch {
      refuse();
    }
    const number = String(olistIntegerFromJson(body.numeroPedido));
    /** @param {any} value */
    const optionalId = (value) =>
      value === undefined || value === null
        ? null
        : olistIntegerFromJson(value, true);
    const historicalMetadata = {
      originId: optionalId(body.ecommerce?.id),
      priceListId: optionalId(body.listaPreco?.id),
      purchaseOrder:
        body.numeroOrdemCompra === undefined ||
        body.numeroOrdemCompra === null ||
        body.numeroOrdemCompra === ''
          ? null
          : text(body.numeroOrdemCompra, 120),
      orderDate,
      deliveryOn,
      paymentDueOn: due,
      productFiscalMissing: fiscalObservations.some(
        (entry) => entry.fiscalMissing,
      ),
      fiscalVerified: false,
      reusable: false,
      products: fiscalObservations,
    };
    const proof = {
      ...checked,
      number,
      mode: 'legacy-sale-only-v1',
      fiscalVerified: false,
    };
    return {
      remoteId: String(wantedId),
      number,
      resources,
      proof,
      commercial: { ...snapshot.commercial, orderDate, paymentDueOn: due },
      historicalMetadata,
      remoteDigest: reads.digest(),
    };
  }
  /** @param {any} input */
  async function existingSale({
    snapshot,
    reference,
    remoteId: selectedId,
    allowLegacyReference = true,
  }) {
    preflight(snapshot, reference);
    if (!snapshot.productFiscal) refuse('OLIST_PRODUCT_FISCAL_REQUIRED');
    const fiscal = olistProductFiscal(snapshot.productFiscal);
    if (!fiscal) refuse('OLIST_PRODUCT_FISCAL_REQUIRED');
    const reads = scope();
    const wantedId = remoteId(selectedId);
    const raw = await reads.read('orderRaw', wantedId);
    const body = parseOlistLosslessJson(raw);
    if (
      olistIntegerFromJson(body?.id) !== wantedId ||
      !Array.isArray(body.itens) ||
      !body.itens.length
    )
      refuse();
    const actualReference = body.ecommerce?.numeroPedidoEcommerce;
    if (
      actualReference !== undefined &&
      actualReference !== null &&
      actualReference !== '' &&
      actualReference !== reference
    )
      refuse('OLIST_SALE_REFERENCE_CONFLICT');
    if (
      (actualReference === undefined ||
        actualReference === null ||
        actualReference === '') &&
      !allowLegacyReference
    )
      refuse('OLIST_SALE_REFERENCE_CONFLICT');
    const expectedCustomer = buildCustomerPayload(
      snapshot.customer,
      'CRM-readonly-customer',
    );
    const customerId = olistIntegerFromJson(body.cliente?.id);
    const customer = await reads.read('contact', customerId);
    if (remoteId(customer?.id) !== customerId)
      refuse('OLIST_CUSTOMER_DIVERGENT');
    customerMatches(customer, expectedCustomer);
    /** @type {Map<number,any>} */ const children = new Map();
    /** @type {Map<number,any>} */ const parents = new Map();
    for (const item of body.itens) {
      const productId = olistIntegerFromJson(item?.produto?.id);
      if (!children.has(productId)) {
        const child = await reads.read('product', productId);
        if (
          remoteId(child?.id) !== productId ||
          child.situacao !== 'A' ||
          child.tipoVariacao !== 'V'
        )
          refuse('OLIST_VARIATION_DIVERGENT');
        const parentId = remoteId(child.produtoPai?.id);
        children.set(productId, child);
        if (!parents.has(parentId)) {
          const parent = await reads.read('product', parentId);
          if (remoteId(parent?.id) !== parentId)
            refuse('OLIST_PRODUCT_DIVERGENT');
          parents.set(parentId, parent);
        }
      }
    }
    /** @type {Map<string,number>} */ const parentByIdentity = new Map();
    const groups = snapshot.commercial.groups.map(
      (/** @type {any} */ group) => {
        const matches = [...parents.values()].filter((parent) => {
          try {
            // A legacy SKU is not evidence by itself. Fiscal identity, composed
            // attributes, parent and independent child grade are all mandatory.
            if (text(parent.sku, 100) !== parent.sku) return false;
            verifyProduct(
              parent,
              { row: { reference: parent.sku }, attributes: group.attributes },
              fiscal,
            );
            return true;
          } catch {
            return false;
          }
        });
        if (matches.length > 1) refuse('OLIST_AMBIGUOUS_MATCH');
        const parent = matches[0];
        if (!parent) refuse('OLIST_PRODUCT_DIVERGENT');
        const identity = JSON.stringify(group.attributes);
        const known = parentByIdentity.get(identity);
        if (known !== undefined && known !== parent.id)
          refuse('OLIST_AMBIGUOUS_MATCH');
        parentByIdentity.set(identity, parent.id);
        return {
          groupId: group.groupId,
          productId: String(remoteId(parent.id)),
          verifiedSku: text(parent.sku, 100),
          lines: group.lines.map((/** @type {any} */ line) => {
            const candidate = childCandidate(
              parent,
              { row: {}, size: line.size },
              false,
            );
            if (!candidate) refuse('OLIST_VARIATION_DIVERGENT');
            text(candidate.sku, 100);
            const childId = remoteId(candidate.id);
            const child = children.get(childId);
            if (
              !child ||
              remoteId(child.produtoPai?.id) !== remoteId(parent.id) ||
              child.sku !== candidate.sku
            )
              refuse('OLIST_VARIATION_DIVERGENT');
            return { lineId: line.lineId, productId: String(childId) };
          }),
        };
      },
    );
    const resources = {
      resolved: true,
      customerId: String(customerId),
      groups,
    };
    const plan = buildOlistSalePayload({
      snapshot,
      resolved: resources,
      reference,
    });
    const used = new Set();
    // Fixed markers constrain the matching first; a missing legacy marker can
    // then be inferred only from the single remaining exact correspondence.
    const orderedItems = [...body.itens].sort(
      (a, b) =>
        Number(Boolean(b.infoAdicional)) - Number(Boolean(a.infoAdicional)),
    );
    for (const item of orderedItems) {
      const productId = String(olistIntegerFromJson(item.produto?.id));
      const quantity = olistIntegerFromJson(item.quantidade);
      const cents = unitCents(item.valorUnitario);
      const matching = plan.prepared.lines.filter(
        (/** @type {any} */ line) =>
          !used.has(line.lineId) &&
          line.quantity === quantity &&
          BigInt(line.unitCents) === cents &&
          plan.lines.find(
            (/** @type {any} */ mapped) => mapped.lineId === line.lineId,
          )?.productId === productId &&
          (item.infoAdicional === undefined ||
            item.infoAdicional === null ||
            item.infoAdicional === '' ||
            item.infoAdicional === line.lineId),
      );
      if (matching.length > 1) refuse('OLIST_AMBIGUOUS_MATCH');
      if (matching.length !== 1) refuse();
      const line = matching[0];
      used.add(line.lineId);
      // Only truly absent legacy markers are adapted after a unique product,
      // quantity and exact-unit correspondence. A present wrong marker fails.
      item.infoAdicional = line.lineId;
    }
    if (used.size !== plan.prepared.lines.length) refuse();
    if (
      actualReference === undefined ||
      actualReference === null ||
      actualReference === ''
    ) {
      if (!body.ecommerce) refuse();
      body.ecommerce.numeroPedidoEcommerce = reference;
    }
    const proof = reconcileOlistSale(plan, encodeLossless(body), wantedId);
    if (!proof.number) refuse();
    return {
      remoteId: String(wantedId),
      number: proof.number,
      resources,
      proof,
      remoteDigest: reads.digest(),
    };
  }
  return Object.freeze({
    existingSale,
    legacyExistingSale,
    /** Historical sale effects retain their original strict request and marker
     * evidence. The manual legacy exception never clears an uncertain effect.
     * @param {{operation:any}} input */
    async reconcileSale({ operation }) {
      const attempt = operation?.saleAttempt;
      const legacy = operation?.resourceMapping ?? operation?.resources;
      if (legacy?.mode === 'legacy-sale-only-v1') {
        if (
          attempt ||
          operation.state !== 'linked' ||
          operation.snapshot?.linkMode !== 'legacy-sale-only-v1' ||
          operation.snapshot?.policy !== 'legacy-sale-only-v1' ||
          !operation.remote_id
        )
          refuse('OLIST_RECONCILIATION_REQUIRED');
        const checked = await legacyExistingSale({
          snapshot: operation.snapshot,
          reference: operation.reference,
          remoteId: operation.remote_id,
          mapping: legacy.legacyCorrespondence,
          paymentDueOn: operation.snapshot.commercial.paymentDueOn,
        });
        if (checked.number !== operation.remote_number)
          refuse('OLIST_SALE_READBACK_MISMATCH');
        if (
          identityHash(
            config.hmacKey,
            'legacy-metadata',
            checked.historicalMetadata,
          ) !==
          identityHash(
            config.hmacKey,
            'legacy-metadata',
            operation.snapshot.historicalMetadata,
          )
        )
          refuse('OLIST_SALE_READBACK_MISMATCH');
        return checked;
      }
      if (!attempt) {
        const reads = scope();
        const known = operation?.observed_sale_id ?? operation?.remote_id;
        const found = known
          ? { id: known }
          : await reads.read('findOrder', operation.reference);
        if (!found) refuse('OLIST_SALE_RECONCILIATION_REQUIRED');
        const linkedIdentity =
          operation.state === 'linked' &&
          operation.remote_id !== null &&
          operation.remote_id !== undefined &&
          String(operation.remote_id) === String(known);
        const checked = await existingSale({
          snapshot: operation.snapshot,
          reference: operation.reference,
          remoteId: found.id,
          allowLegacyReference: linkedIdentity,
        });
        const frozenMapping = operation.resourceMapping ?? operation.resources;
        if (frozenMapping) {
          for (const group of checked.resources.groups) {
            const expected = frozenMapping.groups.filter(
              (/** @type {any} */ entry) => entry.groupId === group.groupId,
            );
            if (
              expected.length !== 1 ||
              String(expected[0].productId) !== group.productId
            )
              refuse('OLIST_SALE_READBACK_MISMATCH');
          }
          const original = buildOlistSalePayload({
            snapshot: operation.snapshot,
            resolved: frozenMapping,
            reference: operation.reference,
          });
          const current = buildOlistSalePayload({
            snapshot: operation.snapshot,
            resolved: checked.resources,
            reference: operation.reference,
          });
          if (original.encoded !== current.encoded)
            refuse('OLIST_SALE_READBACK_MISMATCH');
        }
        const observedNumber =
          operation.observed_sale_number ?? operation.remote_number;
        if (observedNumber && String(observedNumber) !== checked.number)
          refuse('OLIST_SALE_READBACK_MISMATCH');
        if (operation.state === 'linked') {
          if (!linkedIdentity || !Array.isArray(operation.verifiedParents))
            refuse('OLIST_RESOURCE_DIVERGENT');
          for (const group of checked.resources.groups) {
            const expected = operation.verifiedParents.filter(
              (/** @type {any} */ entry) =>
                String(entry.remoteId) === group.productId,
            );
            if (expected.length !== 1 || expected[0].sku !== group.verifiedSku)
              refuse('OLIST_PRODUCT_DIVERGENT');
          }
        }
        return checked;
      }
      const resources = operation.resourceMapping ?? operation.resources;
      const plan = buildOlistSalePayload({
        snapshot: operation.snapshot,
        resolved: resources,
        reference: operation.reference,
      });
      if (plan.encoded !== attempt.requestPayload?.encoded)
        refuse('OLIST_SALE_REQUEST_CHANGED');
      const reads = scope();
      const known =
        attempt.observedRemoteId ??
        attempt.observed_remote_id ??
        operation.observed_sale_id;
      const found = known
        ? { id: known }
        : await reads.read('findOrder', operation.reference);
      if (!found) refuse('OLIST_SALE_RECONCILIATION_REQUIRED');
      const id = remoteId(found.id);
      const raw = await reads.read('orderRaw', id);
      const proof = reconcileOlistSale(plan, raw, id);
      const observedNumber =
        attempt.observedNumber ??
        attempt.observed_remote_number ??
        operation.observed_sale_number;
      if (
        !proof.number ||
        (observedNumber && String(observedNumber) !== proof.number)
      )
        refuse('OLIST_SALE_READBACK_MISMATCH');
      return {
        remoteId: String(id),
        number: proof.number,
        resources,
        proof,
        remoteDigest: reads.digest(),
      };
    },
    /** @param {{resource:any,parent?:any}} input */
    async reconcileResource({ resource, parent }) {
      const reads = scope();
      const known = observed(resource);
      const payload = resource?.payload;
      if (!payload) refuse('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
      let id;
      if (resource.kind === 'customer') {
        const expected = buildCustomerPayload(payload, 'CRM-readonly-customer');
        const method =
          typeof client.findCustomerAcrossStates === 'function'
            ? 'findCustomerAcrossStates'
            : 'findCustomer';
        const candidate = known
          ? { id: known }
          : await reads.read(method, expected.cpfCnpj);
        if (!candidate) refuse('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
        id = remoteId(candidate.id);
        const detail = await reads.read('contact', id);
        if (remoteId(detail?.id) !== id) refuse('OLIST_CUSTOMER_DIVERGENT');
        customerMatches(detail, expected);
      } else if (resource.kind === 'product') {
        const method =
          typeof client.findProductAcrossStates === 'function'
            ? 'findProductAcrossStates'
            : 'findProduct';
        const candidate = known
          ? { id: known }
          : await reads.read(method, resource.reference);
        if (!candidate) refuse('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
        id = remoteId(candidate.id);
        const detail = await reads.read('product', id);
        if (remoteId(detail?.id) !== id) refuse('OLIST_PRODUCT_DIVERGENT');
        verifyProduct(
          detail,
          { row: resource, attributes: payload.attributes },
          payload.fiscal ? olistProductFiscal(payload.fiscal) : null,
        );
      } else if (resource.kind === 'variation') {
        if (
          !parent?.remote_id ||
          parent.state !== 'confirmed' ||
          !parent.payload
        )
          refuse('OLIST_PARENT_UNRESOLVED');
        const parentId = remoteId(parent.remote_id);
        const parentDetail = await reads.read('product', parentId);
        if (remoteId(parentDetail?.id) !== parentId)
          refuse('OLIST_PRODUCT_DIVERGENT');
        verifyProduct(
          parentDetail,
          { row: parent, attributes: parent.payload.attributes },
          parent.payload.fiscal
            ? olistProductFiscal(parent.payload.fiscal)
            : null,
        );
        const candidate = childCandidate(
          parentDetail,
          { row: resource, size: payload.size },
          Boolean(resource.latestAttempt),
        );
        if (!candidate) refuse('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
        id = remoteId(candidate.id);
        // Variation POST may observe its parent ID; any other known child ID
        // must be the same canonical child independently proved by parent grade.
        if (known && remoteId(known) !== parentId && remoteId(known) !== id)
          refuse('OLIST_VARIATION_DIVERGENT');
        const detail = await reads.read('product', id);
        if (
          remoteId(detail?.id) !== id ||
          remoteId(detail.produtoPai?.id) !== parentId ||
          detail.tipoVariacao !== 'V' ||
          detail.situacao !== 'A' ||
          detail.sku !== candidate.sku
        )
          refuse('OLIST_VARIATION_DIVERGENT');
        return {
          remoteId: String(id),
          proof: {
            matched: true,
            kind: 'variation',
            parentRemoteId: String(parentId),
          },
          remoteDigest: reads.digest(),
        };
      } else refuse('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
      return {
        remoteId: String(id),
        proof: { matched: true, kind: resource.kind },
        remoteDigest: reads.digest(),
      };
    },
  });
}
