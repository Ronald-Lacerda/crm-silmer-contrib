import {
  prepareExactCentExport,
  reconcileExactCentExport,
} from '@crm-silmer/orders';
import { OlistError, integer, text } from './errors.js';
import { normalizeDocument } from './configuration.js';
import { buildCustomerPayload } from './resource-payloads.js';
import {
  parseOlistLosslessJson,
  olistNumberLexeme,
  olistIntegerFromJson,
} from './lossless-json.js';
const plans = new WeakSet();
/** @param {any} value */
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
/** @param {string} code @returns {never} */
function refuse(code = 'OLIST_SALE_PLAN_INVALID') {
  throw new OlistError(code, 409);
}
/** @param {unknown} value */
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return false;
  const d = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
/** v3 schema documents a calendar day; the live installment response also
 * uses its literal midnight suffix. Do not parse a timestamp or convert zones.
 * @param {unknown} value */
function returnedDueDay(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}(?: 00:00:00)?$/u.test(value)
  )
    return null;
  const calendar = value.slice(0, 10);
  return day(calendar) ? calendar : null;
}
/** @param {unknown} value */
function id(value) {
  const s = String(value);
  if (!/^[1-9][0-9]{0,15}$/u.test(s)) refuse();
  const n = Number(s);
  if (!Number.isSafeInteger(n) || String(n) !== s) refuse();
  return n;
}
/** @param {number} value */
function cents(value) {
  integer(value);
  const n = BigInt(value);
  return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
}
/** @param {any} value */
function dense(value) {
  if (
    !Array.isArray(value) ||
    Object.keys(value).length !== value.length ||
    Object.keys(value).some((key, i) => key !== String(i))
  )
    refuse();
  return value;
}
/** Freeze official fields from the accepted snapshot and verified resource IDs.
 * The single due date is explicit; free-text paymentTerms never invents days.
 * @param {{snapshot:any,resolved:any,reference:string}} input @returns {any} */
export function buildOlistSalePayload({ snapshot, resolved, reference }) {
  if (
    snapshot?.policy !== 'exact-cent-v1' ||
    resolved?.resolved !== true ||
    !/^CRM-[A-Za-z0-9-]{1,100}$/u.test(reference)
  )
    refuse();
  buildCustomerPayload(snapshot.customer, 'CRM-sale-buyer');
  const settings = snapshot.settings;
  if (
    (settings &&
      Object.hasOwn(settings, 'paymentDuePolicy') &&
      !['fixed_date', 'per_order'].includes(settings.paymentDuePolicy)) ||
    (settings?.paymentDuePolicy === 'per_order' &&
      settings.paymentDueOn !== null &&
      settings.paymentDueOn !== undefined)
  )
    refuse('OLIST_PAYMENT_DUE_REQUIRED');
  const paymentDueOn =
    settings?.paymentDuePolicy === 'per_order'
      ? snapshot.commercial?.paymentDueOn
      : settings?.paymentDueOn;
  if (!settings || !day(paymentDueOn)) refuse('OLIST_PAYMENT_DUE_REQUIRED');
  if (
    settings.paymentDuePolicy !== 'per_order' &&
    snapshot.commercial?.paymentDueOn !== undefined &&
    snapshot.commercial.paymentDueOn !== paymentDueOn
  )
    refuse('OLIST_PAYMENT_DUE_REQUIRED');
  if (
    !day(snapshot.commercial?.orderDate) ||
    !day(snapshot.commercial?.deliveryOn)
  )
    refuse();
  text(settings.paymentTerms, 120);
  const groups = dense(snapshot.commercial.groups);
  const prepared = prepareExactCentExport(
    groups.map((group) => ({
      id: group.groupId,
      lines: dense(group.lines).map((line) => ({
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
    refuse('OLIST_SALE_EXACT_CENT_REQUIRED');
  for (const group of groups)
    for (const source of group.lines) {
      const exact = prepared.lines.find(
        (line) => line.lineId === source.lineId,
      );
      if (
        !exact ||
        source.unitCents !== exact.unitCents ||
        source.unitLexeme !== exact.unitLexeme ||
        source.groupId !== group.groupId
      )
        refuse('OLIST_SALE_EXACT_CENT_REQUIRED');
    }
  const resolvedGroups = dense(resolved.groups),
    seenGroups = new Set(),
    seenLines = new Set();
  if (resolvedGroups.length !== groups.length) refuse();
  /** @type {Map<string,any>} */ const mapped = new Map();
  for (const group of resolvedGroups) {
    if (seenGroups.has(group.groupId)) refuse();
    seenGroups.add(group.groupId);
    id(group.productId);
    const wanted = groups.find((g) => g.groupId === group.groupId);
    if (!wanted || group.lines.length !== wanted.lines.length) refuse();
    for (const line of dense(group.lines)) {
      if (
        seenLines.has(line.lineId) ||
        !wanted.lines.some((/** @type {any} */ x) => x.lineId === line.lineId)
      )
        refuse();
      seenLines.add(line.lineId);
      mapped.set(line.lineId, {
        lineId: line.lineId,
        productId: String(id(line.productId)),
        ...(line.sku !== undefined ? { sku: text(line.sku, 100) } : {}),
      });
    }
  }
  const lines = prepared.lines.map((line) => {
    const product = mapped.get(line.lineId);
    if (!product) refuse();
    return product;
  });
  const customerId = String(id(resolved.customerId)),
    originId = String(integer(settings.originId));
  const payload = {
    idContato: id(customerId),
    data: snapshot.commercial.orderDate,
    dataPrevista: snapshot.commercial.deliveryOn,
    situacao: 0,
    ecommerce: { id: Number(originId), numeroPedidoEcommerce: reference },
    vendedor: { id: integer(settings.sellerId) },
    naturezaOperacao: { id: integer(settings.operationNatureId) },
    deposito: { id: integer(settings.warehouseId) },
    ...(settings.priceListId !== null && settings.priceListId !== undefined
      ? { listaPreco: { id: integer(settings.priceListId) } }
      : {}),
    ...(settings.purchaseOrder !== null && settings.purchaseOrder !== undefined
      ? { numeroOrdemCompra: text(settings.purchaseOrder, 120) }
      : {}),
    pagamento: {
      meioPagamento: { id: integer(settings.paymentMethodId) },
      ...(settings.receivingMethodId !== null &&
      settings.receivingMethodId !== undefined
        ? { formaRecebimento: { id: integer(settings.receivingMethodId) } }
        : {}),
      parcelas: [
        {
          data: paymentDueOn,
          valor: cents(/** @type {number} */ (prepared.totalCents)),
        },
      ],
    },
    itens: prepared.lines.map((line) => ({
      produto: { id: id(mapped.get(line.lineId).productId) },
      quantidade: line.quantity,
      valorUnitario: line.unitLexeme,
      infoAdicional: line.lineId,
    })),
  };
  const encoded = JSON.stringify(payload).replace(
    /"(valorUnitario|valor)":"([0-9]+\.[0-9]{2})"/gu,
    '"$1":$2',
  );
  if (Buffer.byteLength(encoded) > 262144) refuse();
  const plan = freeze({
    encoded,
    prepared,
    reference,
    customerId,
    originId,
    buyerDocument: normalizeDocument(snapshot.customer.cpfCnpj),
    orderDate: payload.data,
    deliveryOn: payload.dataPrevista,
    lines,
    settings: {
      sellerId: settings.sellerId,
      operationNatureId: settings.operationNatureId,
      warehouseId: settings.warehouseId,
      priceListId: settings.priceListId ?? null,
      purchaseOrder: settings.purchaseOrder ?? null,
      paymentMethodId: settings.paymentMethodId,
      receivingMethodId: settings.receivingMethodId ?? null,
      paymentDueOn,
      paymentDuePolicy: settings.paymentDuePolicy ?? 'fixed_date',
    },
    totalLexeme: cents(/** @type {number} */ (prepared.totalCents)),
  });
  plans.add(plan);
  return plan;
}
/** Only plans built and frozen in this process can reach the write port.
 * @param {any} plan @returns {any} */
export function assertOlistSalePlan(plan) {
  if (!plan || !plans.has(plan)) refuse();
  return plan;
}
/** @param {any} value */
function absentOrZero(value) {
  return (
    value === null ||
    value === undefined ||
    /^(?:0(?:\.0+)?)(?:[eE][+-]?[0-9]+)?$/u.test(olistNumberLexeme(value))
  );
}
/** @param {any} value */
function emptyObject(value) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}
/** @param {any} value */
function emptyArray(value) {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  );
}
/** @param {any} actual @param {number|null|undefined} expected */
function optionalId(actual, expected) {
  if (actual === undefined) return;
  if (actual === null) {
    if (expected === null || expected === undefined) return;
    refuse('OLIST_SALE_READBACK_MISMATCH');
  }
  const returned = olistIntegerFromJson(actual?.id, true);
  // The live v3 detail uses {id:0} for an unselected optional catalogue.
  // A zero must never erase an explicitly configured positive identity.
  if ((expected === null || expected === undefined) && returned === 0) return;
  if (returned !== expected) refuse('OLIST_SALE_READBACK_MISMATCH');
}
/** Exact per-line reconciliation. The returned marker correlates identity only;
 * independently returned quantity/unit lexemes prove subtotal, and both totals
 * must match. No upstream body or PII is returned in a problem or observation.
 * @param {any} plan @param {string} raw @param {string|number} remoteId */
export function reconcileOlistSale(plan, raw, remoteId) {
  assertOlistSalePlan(plan);
  try {
    const body = parseOlistLosslessJson(raw);
    if (
      !body ||
      Array.isArray(body) ||
      olistIntegerFromJson(body.id) !== id(remoteId) ||
      olistIntegerFromJson(body.situacao, true) !== 0 ||
      body.data !== plan.orderDate ||
      olistIntegerFromJson(body.cliente?.id) !== id(plan.customerId) ||
      normalizeDocument(body.cliente?.cpfCnpj) !== plan.buyerDocument ||
      olistIntegerFromJson(body.ecommerce?.id) !== id(plan.originId) ||
      body.ecommerce?.numeroPedidoEcommerce !== plan.reference
    )
      refuse('OLIST_SALE_READBACK_MISMATCH');
    if (
      !absentOrZero(body.idNotaFiscal) ||
      !emptyObject(body.notaFiscal) ||
      !emptyArray(body.pagamentosIntegrados) ||
      (body.dataFaturamento !== undefined &&
        body.dataFaturamento !== null &&
        body.dataFaturamento !== '') ||
      (body.origemPedido !== undefined &&
        body.origemPedido !== null &&
        // 3 is the value observed on the authorized API-created proof order;
        // it is not interpreted as evidence of invoice or payment effects.
        ![0, 3].includes(olistIntegerFromJson(body.origemPedido, true))) ||
      ![body.valorDesconto, body.valorFrete, body.valorOutrasDespesas].every(
        absentOrZero,
      )
    )
      refuse('OLIST_SALE_READBACK_MISMATCH');
    if (
      body.dataPrevista !== undefined &&
      body.dataPrevista !== null &&
      body.dataPrevista !== plan.deliveryOn
    )
      refuse('OLIST_SALE_READBACK_MISMATCH');
    optionalId(body.vendedor, plan.settings.sellerId);
    optionalId(body.naturezaOperacao, plan.settings.operationNatureId);
    optionalId(body.deposito, plan.settings.warehouseId);
    optionalId(body.listaPreco, plan.settings.priceListId);
    if (
      body.numeroOrdemCompra !== undefined &&
      body.numeroOrdemCompra !== null &&
      body.numeroOrdemCompra !== plan.settings.purchaseOrder &&
      !(body.numeroOrdemCompra === '' && plan.settings.purchaseOrder === null)
    )
      refuse('OLIST_SALE_READBACK_MISMATCH');
    if (
      plan.settings.paymentDuePolicy === 'per_order' &&
      !Array.isArray(body.pagamento?.parcelas)
    )
      refuse('OLIST_SALE_READBACK_MISMATCH');
    if (body.pagamento) {
      optionalId(body.pagamento.meioPagamento, plan.settings.paymentMethodId);
      optionalId(
        body.pagamento.formaRecebimento,
        plan.settings.receivingMethodId,
      );
      if (
        body.pagamento.parcelas !== undefined &&
        body.pagamento.parcelas !== null
      ) {
        const installments = dense(body.pagamento.parcelas);
        if (
          installments.length !== 1 ||
          returnedDueDay(installments[0].data) !== plan.settings.paymentDueOn ||
          !emptyObject(installments[0].transacao)
        )
          refuse('OLIST_SALE_READBACK_MISMATCH');
        const checked = reconcileExactCentExport(
          {
            policy: 'exact-cent-v1',
            eligible: true,
            totalCents: plan.prepared.totalCents,
            issues: [],
            lines: [
              {
                ...plan.prepared.lines[0],
                quantity: 1,
                subtotalCents: plan.prepared.totalCents,
                unitCents: plan.prepared.totalCents,
                unitLexeme: plan.totalLexeme,
              },
            ],
          },
          {
            lines: [
              {
                lineId: plan.prepared.lines[0].lineId,
                quantity: 1,
                unitLexeme: olistNumberLexeme(installments[0].valor),
              },
            ],
            totalProductsLexeme: plan.totalLexeme,
            totalOrderLexeme: plan.totalLexeme,
          },
        );
        if (!checked.matched) refuse('OLIST_SALE_READBACK_MISMATCH');
      }
    }
    const lines = dense(body.itens).map((line) => {
      const expected = plan.lines.find(
        (/** @type {any} */ value) => value.lineId === line.infoAdicional,
      );
      if (
        !expected ||
        olistIntegerFromJson(line.produto?.id) !== id(expected.productId) ||
        (expected.sku !== undefined && line.produto?.sku !== expected.sku)
      )
        refuse('OLIST_SALE_READBACK_MISMATCH');
      return {
        lineId: line.infoAdicional,
        quantity: olistIntegerFromJson(line.quantidade),
        unitLexeme: olistNumberLexeme(line.valorUnitario),
      };
    });
    const checked = reconcileExactCentExport(plan.prepared, {
      lines,
      totalProductsLexeme: olistNumberLexeme(body.valorTotalProdutos),
      totalOrderLexeme: olistNumberLexeme(body.valorTotalPedido),
    });
    const number =
      body.numeroPedido === undefined || body.numeroPedido === null
        ? null
        : String(olistIntegerFromJson(body.numeroPedido));
    return {
      matched: true,
      lineCount: checked.lineCount,
      totalCents: checked.totalCents,
      number,
    };
  } catch {
    throw new OlistError('OLIST_SALE_READBACK_MISMATCH', 409);
  }
}
