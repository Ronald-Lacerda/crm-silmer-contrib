import { URLSearchParams } from 'node:url';
import { normalizeDocument, OLIST_API } from './configuration.js';
import { OlistError, integer, text } from './errors.js';
import { olistJson } from './transport.js';
const CATALOGS = Object.freeze({
  sellers: '/vendedores',
  warehouses: '/depositos',
  paymentMethods: '/formas-pagamento',
  receivingMethods: '/formas-recebimento',
  priceLists: '/listas-precos',
});
/** Remote data failing local validation is a bad provider response (502), never
 * the caller's INVALID_REQUEST; the message stays the fixed code.
 * @param {unknown} value @param {boolean} [zero] */
function remoteInteger(value, zero = false) {
  try {
    return integer(value, zero);
  } catch {
    throw new OlistError('OLIST_INVALID_RESPONSE', 502);
  }
}
/** @param {unknown} value @param {number} [max] */
function remoteText(value, max = 128) {
  try {
    return text(value, max);
  } catch {
    throw new OlistError('OLIST_INVALID_RESPONSE', 502);
  }
}
/** Fixed official host/routes only. No generic HTTP or arbitrary payload port.
 * @param {{credentials:()=>Promise<{token:string,version:number}>, quota:any, fetch?:typeof fetch, timeoutMs?:number, onAuthFailure?:(version:number)=>Promise<unknown>}} options */
export function createOlistClient(options) {
  /** @param {string} path @param {boolean} [raw] */
  async function get(path, raw = false) {
    const credentials = await options.credentials();
    await options.quota.reserve();
    try {
      const response = await olistJson(OLIST_API + path, {
        token: credentials.token,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        raw,
      });
      await options.quota.observe(response.headers);
      return response.body;
    } catch (error) {
      if (error instanceof OlistError && error.code === 'OLIST_AUTH')
        await options.onAuthFailure?.(credentials.version);
      if (error instanceof OlistError && error.code === 'OLIST_RATE_LIMITED')
        await options.quota.block(/** @type {any} */ (error).retryAfterMs);
      throw error;
    }
  }
  /** @param {string} path @param {number} id */
  async function detail(path, id) {
    integer(id);
    const body = await get(path + '/' + id);
    if (body?.id !== id) throw new OlistError('OLIST_INVALID_RESPONSE', 502);
    return body;
  }
  /** Complete bounded enumeration or explicit incomplete; never prove absence from a truncated page.
   * @param {string} path @param {Record<string,string>} filters */
  async function pages(path, filters) {
    const items = [];
    const ids = new Set();
    let total = null;
    for (let offset = 0; offset < 250; offset += 50) {
      const query = new URLSearchParams({
        ...filters,
        limit: '50',
        offset: String(offset),
      });
      const body = await get(path + '?' + query);
      const page = body?.paginacao;
      if (
        !Array.isArray(body?.itens) ||
        !page ||
        page.offset !== offset ||
        !Number.isSafeInteger(page.total) ||
        page.total < 0 ||
        body.itens.length > 50 ||
        (total !== null && total !== page.total)
      )
        throw new OlistError('OLIST_INCOMPLETE_LOOKUP', 409);
      total = page.total;
      for (const item of body.itens) {
        remoteInteger(item?.id);
        if (ids.has(item.id)) throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
        ids.add(item.id);
        items.push(item);
      }
      if (items.length === total) return items;
      if (items.length > total || body.itens.length !== 50)
        throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
    }
    throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
  }
  /** @param {any[]} items @param {(item:any)=>boolean} matches */
  function exact(items, matches) {
    const found = items.filter(matches);
    if (found.length > 1) throw new OlistError('OLIST_AMBIGUOUS_MATCH');
    return found[0] ?? null;
  }
  const blocked = async () => {
    throw new OlistError('OLIST_CREATION_DISABLED', 409);
  };
  return Object.freeze({
    info: () => get('/info'),
    /** @param {number} id */ contact: (id) => detail('/contatos', id),
    /** @param {number} id */ product: (id) => detail('/produtos', id),
    /** @param {number} id */ order: (id) => detail('/pedidos', id),
    /** Raw numeric lexemes for exact sale reconciliation; no JSON Number money.
     * @param {number} id */ orderRaw: async (id) =>
      get('/pedidos/' + integer(id), true),
    /** @param {string} document */
    async findCustomer(document) {
      const normalized = normalizeDocument(document);
      return exact(await pages('/contatos', { cpfCnpj: normalized }), (row) => {
        try {
          return normalizeDocument(row.cpfCnpj) === normalized;
        } catch {
          return false;
        }
      });
    },
    /** @param {string} sku */
    async findProduct(sku) {
      const value = text(sku, 100);
      return exact(
        await pages('/produtos', { codigo: value }),
        (row) => row.sku === value,
      );
    },
    /** Complete search over all documented states and document formats. Repeated
     * sightings of one ID are one entity; distinct exact identities are ambiguous.
     * @param {string} document */
    async findCustomerAcrossStates(document) {
      const value = normalizeDocument(document);
      const masked =
        value.length === 11
          ? value.replace(/^(...)(...)(...)(..)$/u, '$1.$2.$3-$4')
          : value.replace(/^(..)(...)(...)(....)(..)$/u, '$1.$2.$3/$4-$5');
      const matches = new Map();
      for (const situacao of ['A', 'B', 'I', 'E'])
        for (const cpfCnpj of [value, masked]) {
          for (const row of await pages('/contatos', { cpfCnpj, situacao })) {
            if (typeof row.cpfCnpj !== 'string')
              throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
            if (normalizeDocument(row.cpfCnpj) === value)
              matches.set(row.id, row);
          }
        }
      return exact([...matches.values()], () => true);
    },
    /** @param {string} sku */
    async findProductAcrossStates(sku) {
      const value = text(sku, 100);
      const matches = new Map();
      for (const situacao of ['A', 'I', 'E'])
        for (const row of await pages('/produtos', {
          codigo: value,
          situacao,
        })) {
          if (typeof row.sku !== 'string')
            throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
          if (row.sku === value) matches.set(row.id, row);
        }
      return exact([...matches.values()], () => true);
    },
    /** @param {string} reference */
    async findOrder(reference) {
      const value = text(reference, 100);
      if (!/^CRM-[A-Za-z0-9-]+$/u.test(value))
        throw new OlistError('INVALID_REQUEST', 400);
      const candidates = await pages('/pedidos', {
        numeroPedidoEcommerce: value,
      });
      // List responses may omit the reference; detail must independently confirm.
      const matches = [];
      for (const candidate of candidates) {
        const valueOfOrder = await detail(
          '/pedidos',
          remoteInteger(candidate.id),
        );
        if (typeof valueOfOrder.ecommerce?.numeroPedidoEcommerce !== 'string')
          throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
        if (valueOfOrder.ecommerce.numeroPedidoEcommerce === value)
          matches.push(valueOfOrder);
      }
      return exact(matches, () => true);
    },
    /** @param {string} kind */
    async catalog(kind) {
      if (!Object.hasOwn(CATALOGS, kind))
        throw new OlistError('INVALID_REQUEST', 400);
      const path = CATALOGS[/** @type {keyof typeof CATALOGS} */ (kind)];
      const values =
        kind === 'warehouses' ? await get(path) : await pages(path, {});
      if (!Array.isArray(values) || values.length > 250)
        throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
      return values.map((/** @type {any} */ row) => ({
        id: remoteInteger(row?.id),
        name: remoteText(row?.nome ?? row?.descricao, 120),
      }));
    },
    // F2 deliberately has no ERP write transport. T22/T08 must add a reserved,
    // freshly authorized effect port before these closed methods can operate.
    createCustomer: blocked,
    createProduct: blocked,
    createVariation: blocked,
    createOrder: blocked,
  });
}
