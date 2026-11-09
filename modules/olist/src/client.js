import { URLSearchParams } from 'node:url';
import { normalizeDocument, OLIST_API } from './configuration.js';
import { OlistError, integer, text } from './errors.js';
import { olistJson } from './transport.js';
import { OLIST_QUOTA_LIMIT, OLIST_READ_WAIT } from './quota.js';
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
/** Optional per-call read profile: `patient` is for confirmation reads made
 * while a durable ticket is in hand (longer wait than a plain read).
 * @typedef {{patient?:boolean}} OlistReadOptions */
/** Wait profile of the reads of one client (see `olistReadWait`). Without it
 * a read never waits and an exhausted quota fails at once, as before.
 * `cumulative`: `maxWaitMs` is the budget for all the reads of this client
 * (the API builds one client per request), so the waits add up instead of each
 * read getting its own `maxWaitMs`; the remaining balance is what each read may
 * still wait, and an overrun fails as OLIST_RATE_LIMITED with `retryAfterMs`.
 * @typedef {{maxWaitMs:number,cumulative?:boolean,patientMaxWaitMs?:number,ceiling?:number,beat?:()=>Promise<unknown>|unknown,sleep?:(ms:number)=>Promise<unknown>}} OlistReadWait */
/** Fixed official host/routes only. No generic HTTP or arbitrary payload port.
 * Only GETs wait for quota (`readWait`); there is no write here.
 * @param {{credentials:()=>Promise<{token:string,version:number}>, quota:any, fetch?:typeof fetch, timeoutMs?:number, readWait?:OlistReadWait, onAuthFailure?:(version:number)=>Promise<unknown>}} options */
export function createOlistClient(options) {
  const readWait = options.readWait;
  /** Waited so far by the reads of this client (cumulative profiles only). */
  let spentMs = 0;
  if (
    readWait &&
    (!Number.isSafeInteger(readWait.maxWaitMs) ||
      readWait.maxWaitMs < 0 ||
      readWait.maxWaitMs > 600_000 ||
      (readWait.patientMaxWaitMs !== undefined &&
        (!Number.isSafeInteger(readWait.patientMaxWaitMs) ||
          readWait.patientMaxWaitMs < 0 ||
          readWait.patientMaxWaitMs > 600_000)) ||
      (readWait.ceiling !== undefined &&
        (!Number.isSafeInteger(readWait.ceiling) ||
          readWait.ceiling < 1 ||
          readWait.ceiling > OLIST_QUOTA_LIMIT)))
  )
    throw new OlistError('INVALID_REQUEST', 400);
  /** @param {string} path @param {boolean} [raw] @param {boolean} [patient] */
  async function get(path, raw = false, patient = false) {
    /** @type {{token:string,version:number}} */
    let credentials;
    if (readWait && typeof options.quota.reserveRead === 'function') {
      // Quota first: a token read before a long wait could expire during it.
      const perRead = patient
        ? (readWait.patientMaxWaitMs ?? OLIST_READ_WAIT.patient.maxWaitMs)
        : readWait.maxWaitMs;
      const reserved = await options.quota.reserveRead({
        maxWaitMs:
          readWait.cumulative === true
            ? Math.max(0, Math.min(perRead, readWait.maxWaitMs - spentMs))
            : perRead,
        ceiling: readWait.ceiling,
        beat: readWait.beat,
        sleep: readWait.sleep,
      });
      if (readWait.cumulative === true && Number.isFinite(reserved?.waitedMs))
        spentMs += Number(reserved.waitedMs);
      credentials = await options.credentials();
    } else {
      credentials = await options.credentials();
      await options.quota.reserve();
    }
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
  /** @param {string} path @param {number} id @param {boolean} [patient] */
  async function detail(path, id, patient = false) {
    integer(id);
    const body = await get(path + '/' + id, false, patient);
    if (body?.id !== id) throw new OlistError('OLIST_INVALID_RESPONSE', 502);
    return body;
  }
  /** Complete bounded enumeration or explicit incomplete; never prove absence from a truncated page.
   * @param {string} path @param {Record<string,string>} filters @param {boolean} [patient] */
  async function pages(path, filters, patient = false) {
    const items = [];
    const ids = new Set();
    let total = null;
    for (let offset = 0; offset < 250; offset += 50) {
      const query = new URLSearchParams({
        ...filters,
        limit: '50',
        offset: String(offset),
      });
      const body = await get(path + '?' + query, false, patient);
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
    /** @param {number} id @param {OlistReadOptions} [opts] */ contact: (
      id,
      opts,
    ) => detail('/contatos', id, opts?.patient === true),
    /** @param {number} id @param {OlistReadOptions} [opts] */ product: (
      id,
      opts,
    ) => detail('/produtos', id, opts?.patient === true),
    /** @param {number} id @param {OlistReadOptions} [opts] */ order: (
      id,
      opts,
    ) => detail('/pedidos', id, opts?.patient === true),
    /** Raw numeric lexemes for exact sale reconciliation; no JSON Number money.
     * @param {number} id @param {OlistReadOptions} [opts] */ orderRaw: async (
      id,
      opts,
    ) => get('/pedidos/' + integer(id), true, opts?.patient === true),
    /** @param {string} document @param {OlistReadOptions} [opts] */
    async findCustomer(document, opts) {
      const normalized = normalizeDocument(document);
      return exact(
        await pages(
          '/contatos',
          { cpfCnpj: normalized },
          opts?.patient === true,
        ),
        (row) => {
          try {
            return normalizeDocument(row.cpfCnpj) === normalized;
          } catch {
            return false;
          }
        },
      );
    },
    /** @param {string} sku @param {OlistReadOptions} [opts] */
    async findProduct(sku, opts) {
      const value = text(sku, 100);
      return exact(
        await pages('/produtos', { codigo: value }, opts?.patient === true),
        (row) => row.sku === value,
      );
    },
    /** Complete search over all documented states and document formats. Repeated
     * sightings of one ID are one entity; distinct exact identities are ambiguous.
     * @param {string} document @param {OlistReadOptions} [opts] */
    async findCustomerAcrossStates(document, opts) {
      const patient = opts?.patient === true;
      const value = normalizeDocument(document);
      const masked =
        value.length === 11
          ? value.replace(/^(...)(...)(...)(..)$/u, '$1.$2.$3-$4')
          : value.replace(/^(..)(...)(...)(....)(..)$/u, '$1.$2.$3/$4-$5');
      const matches = new Map();
      for (const situacao of ['A', 'B', 'I', 'E'])
        for (const cpfCnpj of [value, masked]) {
          for (const row of await pages(
            '/contatos',
            { cpfCnpj, situacao },
            patient,
          )) {
            if (typeof row.cpfCnpj !== 'string')
              throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
            if (normalizeDocument(row.cpfCnpj) === value)
              matches.set(row.id, row);
          }
        }
      return exact([...matches.values()], () => true);
    },
    /** @param {string} sku @param {OlistReadOptions} [opts] */
    async findProductAcrossStates(sku, opts) {
      const patient = opts?.patient === true;
      const value = text(sku, 100);
      const matches = new Map();
      for (const situacao of ['A', 'I', 'E'])
        for (const row of await pages(
          '/produtos',
          {
            codigo: value,
            situacao,
          },
          patient,
        )) {
          if (typeof row.sku !== 'string')
            throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
          if (row.sku === value) matches.set(row.id, row);
        }
      return exact([...matches.values()], () => true);
    },
    /** @param {string} reference @param {OlistReadOptions} [opts] */
    async findOrder(reference, opts) {
      const patient = opts?.patient === true;
      const value = text(reference, 100);
      if (!/^CRM-[A-Za-z0-9-]+$/u.test(value))
        throw new OlistError('INVALID_REQUEST', 400);
      const candidates = await pages(
        '/pedidos',
        {
          numeroPedidoEcommerce: value,
        },
        patient,
      );
      // List responses may omit the reference; detail must independently confirm.
      const matches = [];
      for (const candidate of candidates) {
        const valueOfOrder = await detail(
          '/pedidos',
          remoteInteger(candidate.id),
          patient,
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
      let values;
      if (kind === 'warehouses') {
        const body = await get(path);
        // /depositos is not paginated: live v3 wraps the complete list in
        // `itens`; retain the earlier bare-array contract. Do not silently
        // treat a future paginated/partial envelope as a complete catalogue.
        values = Array.isArray(body)
          ? body
          : body && !Object.hasOwn(body, 'paginacao')
            ? body.itens
            : null;
      } else values = await pages(path, {});
      if (!Array.isArray(values) || values.length > 250)
        throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
      const projected = values.map((/** @type {any} */ row) => ({
        id: remoteInteger(row?.id),
        // The seller ID is row.id; contato.id is a different entity. Only its
        // display name is projected, never its document/address/contact data.
        name: remoteText(
          (kind === 'sellers' ? row?.contato?.nome : undefined) ??
            row?.nome ??
            row?.descricao,
          120,
        ),
      }));
      if (new Set(projected.map((row) => row.id)).size !== projected.length)
        throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
      return projected;
    },
    // F2 deliberately has no ERP write transport. T22/T08 must add a reserved,
    // freshly authorized effect port before these closed methods can operate.
    createCustomer: blocked,
    createProduct: blocked,
    createVariation: blocked,
    createOrder: blocked,
  });
}
