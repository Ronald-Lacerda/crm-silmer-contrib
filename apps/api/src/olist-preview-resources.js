import {
  olistResourceIdentityHash,
  normalizeDocument,
  olistProductFiscal,
} from '@crm-silmer/olist';

const PRODUCT_FIELDS = [
  'garment',
  'color',
  'fabric',
  'application',
  'collar',
  'audience',
];
const SAFE_CODES = new Set([
  'OLIST_AMBIGUOUS_MATCH',
  'OLIST_INCOMPLETE_LOOKUP',
  'OLIST_RATE_LIMITED',
  'OLIST_AUTH',
  'OLIST_UNAVAILABLE',
  'OLIST_INVALID_RESPONSE',
  'OLIST_RECONNECT_REQUIRED',
  'OLIST_CONNECTION_CHANGED',
  'FORBIDDEN',
]);
/** @param {unknown} value */
const normalize = (value) =>
  String(value ?? '')
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase('pt-BR');
/** @param {unknown} value */
const remoteId = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : null;
/** @param {any[]} grade @param {string} size */
function sameSize(grade, size) {
  return (
    Array.isArray(grade) &&
    grade.length === 1 &&
    normalize(grade[0]?.chave) === 'tamanho' &&
    normalize(grade[0]?.valor) === normalize(size)
  );
}
/** Current fiscal data must match the buyer source. Reuse never repairs or
 * overwrites an ERP customer that has diverged from the reviewed registration.
 * @param {any} found @param {any} expected */
function sameFiscalCustomer(found, expected) {
  for (const field of ['nome', 'inscricaoEstadual'])
    if (
      expected[field] !== undefined &&
      normalize(found[field]) !== normalize(expected[field])
    )
      return false;
  if (expected.endereco) {
    for (const field of [
      'cep',
      'municipio',
      'uf',
      'endereco',
      'bairro',
      'numero',
      'complemento',
    ]) {
      const actual = found.endereco?.[field];
      const desired = expected.endereco[field];
      if (field === 'cep') {
        if (
          String(actual ?? '').replace(/[^0-9]/gu, '') !==
          String(desired ?? '').replace(/[^0-9]/gu, '')
        )
          return false;
      } else if (normalize(actual) !== normalize(desired)) return false;
    }
  }
  return true;
}
/** Read-only discovery. Results are advisory, never a reservation or permission
 * to retry an uncertain creation. No upstream body or fiscal identity escapes.
 * @param {{client:any,config:{accountKey:string,hmacKey:Buffer},plan:any,resources:any[]}} input */
export async function planOlistResources({ client, config, plan, resources }) {
  /** @type {{code:string,field:string}[]} */
  const issues = [];
  let fiscal = null;
  if (plan.productFiscal !== null && plan.productFiscal !== undefined) {
    try {
      fiscal = olistProductFiscal(plan.productFiscal);
    } catch {
      issues.push({
        code: 'OLIST_PRODUCT_FISCAL_REQUIRED',
        field: 'settings.productFiscal',
      });
    }
  }
  const parentSizes = new Map();
  for (const group of plan.commercial?.groups ?? []) {
    const key = olistResourceIdentityHash(config.hmacKey, {
      accountKey: config.accountKey,
      kind: 'product',
      identity: group.attributes,
    });
    const sizes = parentSizes.get(key) ?? new Set();
    for (const line of group.lines) sizes.add(normalize(line.size));
    parentSizes.set(key, sizes);
    if (sizes.size > 100)
      issues.push({
        code: 'OLIST_RESOURCE_BATCH_LIMIT',
        field: 'groups.' + group.groupId,
      });
  }
  if (issues.length)
    return {
      customer: { action: 'blocked', remoteId: null },
      groups: [],
      issues,
    };
  /** @type {Map<string,Promise<any>>} */
  const reads = new Map();
  let calls = 0;
  /** @param {string} kind @param {any} identity */
  const hash = (kind, identity) =>
    olistResourceIdentityHash(config.hmacKey, {
      accountKey: config.accountKey,
      kind,
      ...(kind === 'variation'
        ? { parentId: identity[0], identity: identity[1] }
        : { identity }),
    });
  /** @param {string} field @param {string} code */
  const issue = (field, code) => issues.push({ code, field });
  /** @param {string} kind @param {string} identity @param {string} field */
  function linked(kind, identity, field) {
    const matches = resources.filter(
      (row) =>
        row.account_key === config.accountKey &&
        row.kind === kind &&
        row.identity_hash === identity,
    );
    if (matches.length > 1) {
      issue(field, 'OLIST_AMBIGUOUS_MATCH');
      return { blocked: true, row: null };
    }
    const row = matches[0] ?? null;
    if (row && !['pending', 'confirmed'].includes(row.state)) {
      issue(field, 'OLIST_RESOURCE_RECONCILIATION_REQUIRED');
      return { blocked: true, row };
    }
    return { blocked: false, row };
  }
  /** @param {string} method @param {any} value */
  async function read(method, value) {
    const key = JSON.stringify([method, value]);
    if (!reads.has(key)) {
      if (++calls > 64)
        throw Object.assign(new Error('OLIST_INCOMPLETE_LOOKUP'), {
          code: 'OLIST_INCOMPLETE_LOOKUP',
        });
      reads.set(
        key,
        Promise.resolve().then(() =>
          (client[method + 'AcrossStates'] ?? client[method]).call(
            client,
            value,
          ),
        ),
      );
    }
    return reads.get(key);
  }
  /** @param {string} field @param {unknown} error */
  function failure(field, error) {
    const code = /** @type {any} */ (error)?.code;
    issue(field, SAFE_CODES.has(code) ? code : 'OLIST_LOOKUP_FAILED');
  }
  /** @returns {{action:string,remoteId:string|null}} */
  const blocked = () => ({ action: 'blocked', remoteId: null });
  let customer = blocked();
  if (plan.customer) {
    const field = 'customer';
    const link = linked(
      'customer',
      hash('customer', normalizeDocument(plan.customer.cpfCnpj)),
      field,
    );
    if (!link.blocked) {
      try {
        let found;
        if (link.row?.state === 'confirmed') {
          const id = remoteId(link.row.remote_id);
          if (!id) throw new Error();
          found = await read('contact', id);
        } else {
          const candidate = await read('findCustomer', plan.customer.cpfCnpj);
          found = candidate ? await read('contact', candidate.id) : null;
        }
        if (!found) customer = { action: 'create', remoteId: null };
        else if (
          normalizeDocument(found.cpfCnpj) !== plan.customer.cpfCnpj ||
          found.tipoPessoa !== plan.customer.tipoPessoa ||
          found.situacao !== 'B' ||
          !remoteId(found.id) ||
          !sameFiscalCustomer(found, plan.customer)
        )
          issue(field, 'OLIST_CUSTOMER_DIVERGENT');
        else customer = { action: 'reuse', remoteId: String(found.id) };
      } catch (error) {
        failure(field, error);
      }
    }
  }
  /** @type {any[]} */
  const groups = [];
  for (const group of plan.commercial?.groups ?? []) {
    const field = 'groups.' + group.groupId;
    const identity = group.attributes;
    const identityKey = hash('product', identity);
    const link = linked('product', identityKey, field);
    const sku = link.row?.reference ?? 'CRM-P-' + identityKey;
    const projected = {
      groupId: group.groupId,
      ...blocked(),
      lines: /** @type {any[]} */ ([]),
    };
    groups.push(projected);
    let parent = null;
    if (!link.blocked) {
      try {
        if (link.row?.state === 'confirmed') {
          const id = remoteId(link.row.remote_id);
          if (!id) throw new Error();
          parent = await read('product', id);
        } else {
          const found = await read('findProduct', sku);
          parent = found ? await read('product', found.id) : null;
        }
        if (!parent) {
          projected.action = 'create';
          // Fiscal defaults are account-specific and have not been approved.
          if (!fiscal) issue(field, 'OLIST_PRODUCT_FISCAL_REQUIRED');
        } else if (
          parent.tipo !== 'V' ||
          parent.situacao !== 'A' ||
          !remoteId(parent.id) ||
          !Array.isArray(parent.variacoes)
        ) {
          parent = null;
          issue(field, 'OLIST_PRODUCT_DIVERGENT');
        } else if (
          fiscal &&
          (String(parent.ncm ?? '').replace(/[.\s]/gu, '') !== fiscal.ncm ||
            !(
              (typeof parent.origem === 'number' &&
                Number.isInteger(parent.origem) &&
                parent.origem >= 0 &&
                parent.origem <= 8) ||
              (typeof parent.origem === 'string' &&
                /^[0-8]$/u.test(parent.origem))
            ) ||
            Number(parent.origem) !== fiscal.origin ||
            normalize(parent.unidade) !== normalize(fiscal.unit))
        ) {
          parent = null;
          issue(field, 'OLIST_PRODUCT_FISCAL_DIVERGENT');
        } else {
          const description = PRODUCT_FIELDS.map((key) => group.attributes[key])
            .filter((value) => value !== '')
            .join(' | ');
          if (
            parent.sku !==
              (link.row?.state === 'confirmed' &&
              String(link.row.remote_id) === String(parent.id)
                ? (link.row.verified_remote_sku ?? link.row.reference ?? sku)
                : (link.row?.reference ?? sku)) ||
            normalize(parent.descricao) !== normalize(description)
          ) {
            parent = null;
            issue(field, 'OLIST_PRODUCT_ATTRIBUTES_UNVERIFIED');
          } else {
            projected.action = 'reuse';
            projected.remoteId = String(parent.id);
          }
        }
      } catch (error) {
        failure(field, error);
        parent = null;
      }
    }
    for (const line of group.lines) {
      const lineField = field + '.lines.' + line.lineId;
      const projectedLine = { lineId: line.lineId, ...blocked() };
      projected.lines.push(projectedLine);
      const variationLink = link.row
        ? linked(
            'variation',
            hash('variation', [link.row.id, normalize(line.size)]),
            lineField,
          )
        : { blocked: false, row: null };
      if (variationLink.blocked || projected.action === 'blocked') continue;
      if (!parent) {
        projectedLine.action = 'create';
        continue;
      }
      try {
        const matches = parent.variacoes.filter((/** @type {any} */ value) =>
          sameSize(value.grade, line.size),
        );
        if (matches.length > 1) {
          issue(lineField, 'OLIST_AMBIGUOUS_MATCH');
          continue;
        }
        if (variationLink.row?.state === 'confirmed') {
          const id = remoteId(variationLink.row.remote_id);
          if (!id || matches.length !== 1 || matches[0].id !== id) {
            issue(lineField, 'OLIST_VARIATION_DIVERGENT');
            continue;
          }
        }
        if (matches.length === 0) {
          projectedLine.action = 'create';
          continue;
        }
        const id = remoteId(matches[0].id);
        if (!id) throw new Error();
        const detail = await read('product', id);
        if (
          detail.id !== id ||
          detail.produtoPai?.id !== parent.id ||
          detail.tipoVariacao !== 'V' ||
          detail.situacao !== 'A' ||
          detail.sku !== matches[0].sku
        ) {
          issue(lineField, 'OLIST_VARIATION_DIVERGENT');
          continue;
        }
        projectedLine.action = 'reuse';
        projectedLine.remoteId = String(id);
      } catch (error) {
        failure(lineField, error);
      }
    }
  }
  return { customer, groups, issues };
}
