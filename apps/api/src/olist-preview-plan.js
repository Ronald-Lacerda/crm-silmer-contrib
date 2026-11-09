import {
  missingForConfirmation,
  operationalDay,
  prepareExactCentExport,
  sizePricingSummary,
  validateArtwork,
  validateItems,
} from '@crm-silmer/orders';
import {
  CONTACT_REGISTRATION_FIELDS,
  normalizeContactEmail,
  normalizeContactPhone,
  normalizeContactRegistration,
} from '@crm-silmer/contacts';
import { olistBuyerRegistrationEmpty } from '@crm-silmer/olist';

const REQUIRED_REGISTRATION = [
  'personType',
  'document',
  'legalName',
  'postalCode',
  'city',
  'state',
  'street',
  'district',
  'number',
];
const REQUIRED_SETTINGS = [
  'sellerId',
  'operationNatureId',
  'warehouseId',
  'paymentMethodId',
  'originId',
];

/** @param {unknown} value @param {number} [max] */
function validText(value, max = 200) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

/** @param {unknown} value */
function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return false;
  const instant = new Date(value + 'T00:00:00.000Z');
  return (
    Number.isFinite(instant.getTime()) &&
    instant.toISOString().slice(0, 10) === value
  );
}

/**
 * OLIST-T06: pure validation of a server-owned source. This is a proposal,
 * never an ERP effect, a reservation, or proof of current authorization.
 * Fields follow the captured official v3 customer schema. No ficha spread,
 * service notes, artwork, attachments or caller-supplied total leaves here.
 * The caller fences the source, buyer, configuration and account revisions.
 *
 * @param {{source:{order:any,sourceRevision:number,issues:{code:string,field:string}[]},
 * buyer:{name:string,phone:string|null,email?:string|null,registration:any}|null,
 * settings:any,now:Date,paymentDueOn?:unknown,buyerSource?:any}} input
 * @returns {{eligible:boolean,issues:{code:string,field:string}[],commercial:any,customer:any,productFiscal?:any,productFiscalDeferred?:boolean,buyerSource?:any}}
 */
export function buildOlistPreviewPlan(input) {
  /** @type {{code:string,field:string}[]} */
  const issues = [];
  /** @param {string} code @param {string} field */
  const issue = (code, field) => {
    if (!issues.some((entry) => entry.code === code && entry.field === field))
      issues.push({ code, field });
  };
  for (const entry of input.source.issues) issue(entry.code, entry.field);

  const settings = input.settings;
  const erpDue = settings?.paymentDuePolicy === 'erp';
  for (const key of REQUIRED_SETTINGS)
    if (
      !(erpDue && key === 'paymentMethodId') &&
      (!Number.isSafeInteger(settings?.[key]) || settings[key] <= 0)
    )
      issue('OLIST_SETTINGS_REQUIRED', 'settings.' + key);
  const perOrderDue = settings?.paymentDuePolicy === 'per_order';
  const paymentDueOn = erpDue
    ? null
    : perOrderDue
      ? input.paymentDueOn
      : settings?.paymentDueOn;
  if (!erpDue && !calendarDay(paymentDueOn))
    issue(
      perOrderDue ? 'OLIST_PAYMENT_DUE_REQUIRED' : 'OLIST_SETTINGS_REQUIRED',
      perOrderDue ? 'commercial.paymentDueOn' : 'settings.paymentDueOn',
    );
  if (
    !perOrderDue &&
    input.paymentDueOn !== undefined &&
    input.paymentDueOn !== paymentDueOn
  )
    issue('OLIST_SETTINGS_INVALID', 'commercial.paymentDueOn');
  if (
    !erpDue &&
    settings?.receivingMethodId !== undefined &&
    settings.receivingMethodId !== null &&
    (!Number.isSafeInteger(settings.receivingMethodId) ||
      settings.receivingMethodId <= 0)
  )
    issue('OLIST_SETTINGS_INVALID', 'settings.receivingMethodId');
  if (!erpDue && !validText(settings?.paymentTerms, 120))
    issue('OLIST_SETTINGS_REQUIRED', 'settings.paymentTerms');
  for (const key of ['priceListId'])
    if (
      settings?.[key] !== null &&
      settings?.[key] !== undefined &&
      (!Number.isSafeInteger(settings[key]) || settings[key] <= 0)
    )
      issue('OLIST_SETTINGS_INVALID', 'settings.' + key);
  if (
    settings?.purchaseOrder !== null &&
    settings?.purchaseOrder !== undefined &&
    !validText(settings.purchaseOrder, 120)
  )
    issue('OLIST_SETTINGS_INVALID', 'settings.purchaseOrder');

  const buyer = input.buyer;
  const source = input.buyerSource;
  const existingBuyer =
    source?.mode === 'erp-existing-v1' &&
    olistBuyerRegistrationEmpty(buyer?.registration) &&
    typeof source.remoteId === 'string' &&
    /^[1-9][0-9]{0,15}$/u.test(source.remoteId) &&
    Number.isSafeInteger(Number(source.remoteId)) &&
    typeof buyer?.name === 'string' &&
    source.identity?.name ===
      buyer.name.normalize('NFC').trim().toLocaleLowerCase('pt-BR') &&
    source.identity?.phone === normalizeContactPhone(buyer?.phone);
  if (source && !existingBuyer) issue('OLIST_BUYER_INVALID', 'buyer.source');
  const normalized = normalizeContactRegistration(
    Object.fromEntries(
      CONTACT_REGISTRATION_FIELDS.map((key) => [
        key,
        buyer?.registration?.[key] ?? null,
      ]),
    ),
  );
  if (!existingBuyer && !normalized.ok)
    for (const key of Object.keys(normalized.errors))
      issue('OLIST_BUYER_INVALID', 'buyer.registration.' + key);
  const registration = normalized.ok ? normalized.value : null;
  for (const key of REQUIRED_REGISTRATION)
    if (
      !existingBuyer &&
      !registration?.[/** @type {keyof typeof registration} */ (key)]
    )
      issue('OLIST_BUYER_REQUIRED', 'buyer.registration.' + key);
  if (
    !existingBuyer &&
    registration?.personType === 'company' &&
    !registration.stateRegistration
  )
    issue('OLIST_BUYER_REQUIRED', 'buyer.registration.stateRegistration');
  const phone = normalizeContactPhone(buyer?.phone);
  if (!phone) issue('OLIST_BUYER_REQUIRED', 'buyer.phone');
  if (!validText(buyer?.name, 150)) issue('OLIST_BUYER_REQUIRED', 'buyer.name');
  const email = normalizeContactEmail(buyer?.email);
  if (!existingBuyer && email === undefined)
    issue('OLIST_BUYER_INVALID', 'buyer.email');

  /** @type {any} */
  let customer = null;
  if (
    existingBuyer &&
    phone &&
    !issues.some((entry) => entry.field.startsWith('buyer.'))
  )
    customer = { nome: source.identity.name, celular: phone };
  if (
    !existingBuyer &&
    registration &&
    phone &&
    !issues.some((entry) => entry.field.startsWith('buyer.'))
  ) {
    customer = {
      tipoPessoa: registration.personType === 'individual' ? 'F' : 'J',
      cpfCnpj: registration.document,
      nome: registration.legalName,
      celular: phone,
      ...(email ? { email } : {}),
      ...(registration.stateRegistration
        ? { inscricaoEstadual: registration.stateRegistration }
        : {}),
      endereco: {
        cep: registration.postalCode,
        municipio: registration.city,
        uf: registration.state,
        endereco: registration.street,
        bairro: registration.district,
        numero: registration.number,
        ...(registration.complement
          ? { complemento: registration.complement }
          : {}),
      },
      situacao: 'B',
    };
  }

  const order = input.source.order;
  /** @type {any} */
  const commercial = {
    groups: [],
    totalCents: null,
    orderDate: null,
    deliveryOn: null,
    paymentCondition: null,
    paymentDueOn: calendarDay(paymentDueOn) ? paymentDueOn : null,
  };
  if (!order) issue('OLIST_SOURCE_INCOMPLETE', 'source');
  else {
    if (!['pendente', 'confirmado'].includes(order.status))
      issue('OLIST_ORDER_INVALID', 'status');
    if (order.cancelledAt) issue('OLIST_ORDER_CANCELLED', 'cancelledAt');
    try {
      validateItems(order.ficha.items);
      for (const [index, item] of order.ficha.items.entries()) {
        for (const key of ['tipo', 'cor', 'tipo_servico', 'gola'])
          if (!validText(item[key]))
            issue('OLIST_ORDER_REQUIRED', `items[${index}].${key}`);
        if (
          !item.malhas.every((/** @type {unknown} */ value) => validText(value))
        )
          issue('OLIST_SOURCE_INVALID', `items[${index}].malhas`);
        for (const line of item.grade)
          if (!validText(line.tamanho))
            issue('OLIST_SOURCE_INVALID', `items[${index}].grade`);
      }
      const artwork = order.ficha.artwork;
      validateArtwork({
        feito_pelo_cliente: artwork?.feito_pelo_cliente ?? false,
        feito_pela_silmer: artwork?.feito_pela_silmer ?? false,
        sem_estampa: artwork?.sem_estampa ?? false,
      });
      // Deliberately ignore persisted missingFields and confirmed shortcuts.
      for (const field of missingForConfirmation({
        ...order,
        status: 'pendente',
      }))
        issue('OLIST_ORDER_REQUIRED', field);
      const pricing = sizePricingSummary(order.ficha);
      if (pricing.complete && pricing.totalCents !== order.finalAmountCents)
        issue('OLIST_TOTAL_MISMATCH', 'finalAmountCents');
      const exact = prepareExactCentExport(order.ficha.sizePricing);
      for (const entry of exact.issues)
        issue(
          entry.code,
          ['sizePricing', entry.groupId, entry.lineId]
            .filter(Boolean)
            .join('.'),
        );
      commercial.totalCents = exact.totalCents;
      commercial.deliveryOn = order.ficha.summary.data_entrega_confirmada;
      commercial.paymentCondition = order.paymentCondition;
      if (order.orderDate === null || order.orderDate === undefined) {
        if (
          !(input.now instanceof Date) ||
          !Number.isFinite(input.now.getTime())
        )
          issue('OLIST_ORDER_INVALID', 'orderDate');
        else commercial.orderDate = operationalDay(input.now);
      } else if (calendarDay(order.orderDate))
        commercial.orderDate = order.orderDate;
      else issue('OLIST_ORDER_INVALID', 'orderDate');
      if (issues.length === 0) {
        commercial.groups = order.ficha.sizePricing.map(
          (/** @type {any} */ group, /** @type {number} */ index) => {
            const item = order.ficha.items[index];
            return {
              groupId: group.id,
              attributes: {
                garment: item.tipo.normalize('NFC').trim(),
                color: item.cor.normalize('NFC').trim(),
                fabric: JSON.stringify(
                  item.malhas
                    .map((/** @type {string} */ value) =>
                      value.normalize('NFC').trim(),
                    )
                    .sort(),
                ),
                application: item.tipo_servico.normalize('NFC').trim(),
                collar: item.gola.normalize('NFC').trim(),
                audience: (item.publico ?? '').normalize('NFC').trim(),
              },
              lines: exact.lines
                .filter((line) => line.groupId === group.id)
                .map((line) => ({
                  ...line,
                  size: group.lines.find(
                    (/** @type {any} */ value) => value.id === line.lineId,
                  ).size,
                })),
            };
          },
        );
      }
    } catch {
      issue('OLIST_SOURCE_INVALID', 'source');
      commercial.groups = [];
    }
  }
  return {
    eligible: issues.length === 0,
    issues,
    commercial,
    customer,
    ...(existingBuyer ? { buyerSource: structuredClone(source) } : {}),
  };
}
