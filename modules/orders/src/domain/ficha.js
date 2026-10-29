import { OrderInputError, OrderValidationError } from './errors.js';
import { AUDIENCES, parseAudiences } from './audiences.js';
import { parseSizes } from './sizes.js';

// The ficha mirrors the approved `ficha-canonical-v2` blocks (D10): summary,
// items with their grade, and up to five observation lines. Anything the agent
// collected that has no place on the printed document stays as service data
// (D11): shown read-only, never printed.
//
// ADR 016/020: an item is built around seven points. The principal fields,
// in the order the page shows them, are the type of garment (`tipo`), colour
// (`cor`), quantity (never stored: the sum of `grade`), technique
// (`tipo_servico`, read as "Técnica"), fabric (`malhas`), sizes (`grade`) and
// collar (`gola`). Who makes the art belongs to the whole order (`artwork`).
// The print description (`estampa`), the colour of each part and the sleeve
// binding are additional; the model and the old collar binding stay stored
// for legacy orders.
//
// ADR 025: an item may also say its audience (`publico`) and the quantity the
// customer said for it (`quantidade_informada`); both are optional, never
// block the order, and the quantity is only a reference next to the grade:
// it is never added to the total of pieces, which stays the sum of grades.

export const NOT_APPLICABLE = 'NAO APLICAVEL';
// What the bot records when the customer leaves a point to the seller. It is
// an answer to the bot, never a value of the ficha.
export const DEFERRED = 'Definir com o vendedor';
export const MAX_OBSERVATIONS = 5;
const MAX_ITEMS = 50;
const MAX_TEXT = 200;

// The stored principal fields that must be filled to generate the order, in
// the order the page shows them; a missing grade is also the missing quantity.
export const ITEM_REQUIRED_FIELDS = Object.freeze(
  /** @type {const} */ ([
    'tipo',
    'cor',
    'tipo_servico',
    'malhas',
    'grade',
    'gola',
  ]),
);
export const ITEM_EXTRA_FIELDS = Object.freeze(
  /** @type {const} */ ([
    'modelo',
    'cor_frente',
    'cor_costas',
    'cor_manga_direita',
    'cor_manga_esquerda',
    'vies_gola',
    'vies_mangas',
  ]),
);

const SUMMARY_INPUT_KEYS = Object.freeze(['data_entrega_confirmada', 'nome']);
// ADR 020: the order-wide technique is no longer edited. An older client may
// still send it; the key is accepted and ignored, and the stored value stays.
const LEGACY_SUMMARY_KEYS = Object.freeze(['aplicacao']);
const ARTWORK_ORIGINS = Object.freeze(
  /** @type {const} */ ([
    'feito_pelo_cliente',
    'feito_pela_silmer',
    'sem_estampa',
  ]),
);
const ITEM_TEXT_KEYS = Object.freeze([
  'tipo',
  'tipo_servico',
  'cor',
  'estampa',
  'gola',
  ...ITEM_EXTRA_FIELDS,
]);
// Optional and legacy fields may be absent in the seven-point form, but
// values supplied by older clients are still validated and preserved.
const OPTIONAL_ITEM_TEXT_KEYS = new Set([
  'tipo_servico',
  'cor',
  'estampa',
  'gola',
  ...ITEM_EXTRA_FIELDS,
]);
const ITEM_KEYS = new Set([
  ...ITEM_TEXT_KEYS,
  'malhas',
  'grade',
  'publico',
  'quantidade_informada',
]);
const MAX_INFORMED_QUANTITY = 100000;
const GRADE_KEYS = new Set(['tamanho', 'quantidade']);

// Workflow bookkeeping, not facts about the order.
const BRIEFING_INTERNAL_KEYS = new Set([
  'briefing_status',
  'next_required_field',
]);
// The briefing fields that describe the first item: any of them opens it, as
// does a named technique. Who makes the art (`artwork_status`) belongs to the
// order, and where the print goes only rides along an item already open.
const ITEM_BRIEFING_KEYS = Object.freeze([
  'audiences',
  'product_model',
  'product_type',
  'colors',
  'quantity',
  'fabrics',
  'sizes',
  'collar',
]);

/**
 * @typedef {{tamanho: string, quantidade: number}} GradeLine
 * @typedef {{
 *   tipo: string, tipo_servico?: string, cor: string, estampa: string, malhas: string[],
 *   grade: GradeLine[], gola: string, modelo: string,
 *   cor_frente: string, cor_costas: string,
 *   cor_manga_direita: string, cor_manga_esquerda: string,
 *   vies_gola: string, vies_mangas: string,
 *   publico: string, quantidade_informada: number|null,
 * }} FichaItem
 * @typedef {{data_entrega_confirmada: string|null, nome: string|null}} FichaSummaryInput
 * @typedef {FichaSummaryInput & {cliente: string, aplicacao?: string|null}} FichaSummary
 * @typedef {{
 *   feito_pelo_cliente: boolean, feito_pela_silmer: boolean,
 *   sem_estampa: boolean, files: unknown[],
 * }} FichaArtwork
 * @typedef {{
 *   summary: FichaSummary, items: FichaItem[], observations: string[],
 *   artwork?: FichaArtwork, serviceData: Record<string, unknown>,
 *   loja?: import('./store-order.js').StoreFicha,
 * }} Ficha
 */

/** @returns {FichaItem} */
export function blankItem() {
  return {
    cor: '',
    cor_costas: '',
    cor_frente: '',
    cor_manga_direita: '',
    cor_manga_esquerda: '',
    estampa: '',
    gola: '',
    grade: [],
    malhas: [],
    modelo: '',
    publico: '',
    quantidade_informada: null,
    tipo: '',
    tipo_servico: '',
    vies_gola: '',
    vies_mangas: '',
  };
}

/** @returns {FichaArtwork} */
export function blankArtwork() {
  return {
    feito_pela_silmer: false,
    feito_pelo_cliente: false,
    files: [],
    sem_estampa: false,
  };
}

/**
 * ADR 020: the order says who makes the art once it has one mark.
 *
 * @param {Partial<FichaArtwork>|null|undefined} artwork
 */
export function hasArtworkOrigin(artwork) {
  return ARTWORK_ORIGINS.some((origin) => artwork?.[origin] === true);
}

/**
 * ADR 016: a ficha stored before the seven-point item has no `cor`,
 * `estampa` or `gola`; ADR 020 adds `sem_estampa` to the art; ADR 025 adds
 * `publico` and `quantidade_informada`. They are read blank, so nothing is
 * migrated and the encrypted envelope keeps its version.
 *
 * @param {Ficha} ficha
 * @returns {Ficha}
 */
export function normalizeFicha(ficha) {
  const copy = structuredClone(ficha);
  return {
    ...copy,
    artwork: { ...blankArtwork(), ...copy.artwork },
    items: (copy.items ?? []).map((item) => ({
      ...blankItem(),
      ...item,
      gola: item.gola || item.vies_gola || '',
      grade: Array.isArray(item.grade) ? item.grade : [],
      malhas: Array.isArray(item.malhas) ? item.malhas : [],
    })),
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** @param {unknown} value @param {string} field @returns {string} */
function requireText(value, field) {
  if (typeof value !== 'string' || value.length > MAX_TEXT) {
    throw new OrderInputError(`${field} must be text`, [field]);
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field @returns {string|null} */
function optionalText(value, field) {
  if (value === null) return null;
  const text = requireText(value, field);
  return text === '' ? null : text;
}

/** @param {Record<string, unknown>} input @param {Set<string>} allowed @param {string} prefix */
function rejectUnknownKeys(input, allowed, prefix) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new OrderInputError(`${prefix}.${key} is not allowed`, [
        `${prefix}.${key}`,
      ]);
    }
  }
}

/**
 * The customer is locked to the conversation contact (D13), so it is never
 * accepted from the seller's section input.
 *
 * @param {unknown} input
 * @returns {FichaSummaryInput}
 */
export function validateSummary(input) {
  if (!isPlainObject(input)) {
    throw new OrderInputError('summary must be an object', ['summary']);
  }
  rejectUnknownKeys(
    input,
    new Set([...SUMMARY_INPUT_KEYS, ...LEGACY_SUMMARY_KEYS]),
    'summary',
  );
  /** @type {Record<string, string|null>} */
  const summary = {};
  for (const key of SUMMARY_INPUT_KEYS) {
    if (!Object.hasOwn(input, key)) {
      throw new OrderInputError(`summary.${key} is required`, [
        `summary.${key}`,
      ]);
    }
    summary[key] = optionalText(input[key], `summary.${key}`);
  }
  return /** @type {FichaSummaryInput} */ (summary);
}

/**
 * @param {unknown} input
 * @returns {FichaItem[]}
 */
export function validateItems(input) {
  if (!Array.isArray(input) || input.length > MAX_ITEMS) {
    throw new OrderInputError('items must be a list', ['items']);
  }
  return input.map((raw, itemIndex) => validateItem(raw, itemIndex));
}

/**
 * ADR 016: an item may be saved half filled — the bot opens the order with
 * what it has and the seller completes it — so nothing here is required to
 * have a value. What is there must still be well formed: text fields are
 * text, a fabric line is not blank and every size line names a size with a
 * whole quantity above zero.
 *
 * @param {unknown} raw @param {number} itemIndex @returns {FichaItem}
 */
function validateItem(raw, itemIndex) {
  const prefix = `items[${itemIndex}]`;
  if (!isPlainObject(raw)) {
    throw new OrderInputError(`${prefix} must be an object`, [prefix]);
  }
  rejectUnknownKeys(raw, ITEM_KEYS, prefix);
  /** @type {Record<string, unknown>} */
  const item = {};
  for (const key of ITEM_TEXT_KEYS) {
    item[key] =
      OPTIONAL_ITEM_TEXT_KEYS.has(key) && !Object.hasOwn(raw, key)
        ? ''
        : requireText(raw[key], `${prefix}.${key}`);
  }
  item.gola = item.gola || item.vies_gola;
  item.publico = optionalAudience(raw.publico, `${prefix}.publico`);
  item.quantidade_informada = optionalInformedQuantity(
    raw.quantidade_informada,
    `${prefix}.quantidade_informada`,
  );

  const malhas = Array.isArray(raw.malhas)
    ? raw.malhas.map((value) => requireText(value, `${prefix}.malhas`))
    : null;
  if (!malhas || malhas.some((value) => value === '')) {
    throw new OrderInputError(`${prefix}.malhas must be a list of fabrics`, [
      `${prefix}.malhas`,
    ]);
  }
  item.malhas = malhas;

  if (!Array.isArray(raw.grade)) {
    throw new OrderValidationError(
      'Informe os tamanhos como uma lista.',
      'INVALID_GRADE',
      [`${prefix}.grade`],
      { itemIndex },
    );
  }
  item.grade = raw.grade.map((line, index) => {
    const refuse = () =>
      new OrderValidationError(
        'Use uma quantidade inteira maior que zero.',
        'INVALID_GRADE',
        [`${prefix}.grade[${index}]`],
        { index, itemIndex },
      );
    if (!isPlainObject(line)) throw refuse();
    for (const key of Object.keys(line)) {
      if (!GRADE_KEYS.has(key)) throw refuse();
    }
    const { quantidade, tamanho } = line;
    if (
      typeof tamanho !== 'string' ||
      tamanho.trim() === '' ||
      tamanho.length > MAX_TEXT ||
      !Number.isSafeInteger(quantidade) ||
      /** @type {number} */ (quantidade) <= 0
    ) {
      throw refuse();
    }
    return {
      quantidade: /** @type {number} */ (quantidade),
      tamanho: tamanho.trim(),
    };
  });
  return /** @type {FichaItem} */ (item);
}

/**
 * ADR 025: the audience is one of the closed list (D1), or blank when the
 * customer did not split the order.
 *
 * @param {unknown} value @param {string} field @returns {string}
 */
function optionalAudience(value, field) {
  if (value === undefined || value === null || value === '') return '';
  if (
    typeof value !== 'string' ||
    !AUDIENCES.includes(/** @type {any} */ (value))
  ) {
    throw new OrderInputError(
      `${field} must be one of ${AUDIENCES.join(', ')}`,
      [field],
    );
  }
  return value;
}

/**
 * ADR 025: the quantity the customer said for the item, a reference only.
 *
 * @param {unknown} value @param {string} field @returns {number|null}
 */
function optionalInformedQuantity(value, field) {
  if (value === undefined || value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    /** @type {number} */ (value) <= 0 ||
    /** @type {number} */ (value) > MAX_INFORMED_QUANTITY
  ) {
    throw new OrderInputError(
      `${field} must be a whole number from 1 to ${MAX_INFORMED_QUANTITY}`,
      [field],
    );
  }
  return /** @type {number} */ (value);
}

/**
 * ADR 020: who makes the art, as the seller confirms it in "Estampa e
 * arquivos". The customer sending art and Silmer creating it may both be
 * true; "Sem estampa" excludes them. An older client that does not send
 * `sem_estampa` reads it as false. File bytes and metadata are not accepted
 * until durable storage is ready.
 *
 * @param {unknown} input
 * @returns {FichaArtwork}
 */
export function validateArtwork(input) {
  if (!isPlainObject(input)) {
    throw new OrderInputError('artwork must be an object', ['artwork']);
  }
  rejectUnknownKeys(input, new Set(ARTWORK_ORIGINS), 'artwork');
  const artwork = blankArtwork();
  for (const field of ARTWORK_ORIGINS) {
    if (field === 'sem_estampa' && !Object.hasOwn(input, field)) continue;
    if (typeof input[field] !== 'boolean') {
      throw new OrderInputError(`artwork.${field} must be boolean`, [
        `artwork.${field}`,
      ]);
    }
    artwork[field] = /** @type {boolean} */ (input[field]);
  }
  if (
    artwork.sem_estampa &&
    (artwork.feito_pelo_cliente || artwork.feito_pela_silmer)
  ) {
    throw new OrderInputError(
      'artwork.sem_estampa cannot be combined with an art origin',
      ['artwork.sem_estampa'],
    );
  }
  return artwork;
}

/**
 * @param {unknown} input
 * @returns {string[]}
 */
export function validateObservations(input) {
  if (!Array.isArray(input) || input.length > MAX_OBSERVATIONS) {
    throw new OrderInputError(
      `observations must be at most ${MAX_OBSERVATIONS} lines`,
      ['observations'],
    );
  }
  return input
    .map((line) => requireText(line, 'observations'))
    .filter((line) => line !== '');
}

/** @param {{grade: readonly GradeLine[]}} item */
export function itemTotal(item) {
  return item.grade.reduce((total, line) => total + line.quantidade, 0);
}

/** @param {readonly {grade: readonly GradeLine[]}[]} items */
export function orderTotal(items) {
  return items.reduce((total, item) => total + itemTotal(item), 0);
}

/** @param {unknown} value @returns {string|undefined} */
function briefingText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** @param {string} text */
function foldText(text) {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

/** @param {string} text */
function isDeferred(text) {
  return foldText(text).replace(/[.!]+$/u, '') === foldText(DEFERRED);
}

/** "Sem aplicação" is how the bot records a plain garment. @param {string} text */
function isPlain(text) {
  return /^(sem (aplicacao|estampa)|lis[ao]s?)[.!]?$/u.test(foldText(text));
}

/**
 * The texts in a briefing value (text, a number or a list of them), without
 * blanks and without the seller's placeholder. Undefined when the value has
 * another shape, or holds nothing but the placeholder: either way it stays as
 * service data for the seller to read.
 *
 * @param {unknown} value
 * @returns {string[]|undefined}
 */
function briefingParts(value) {
  const entries = Array.isArray(value) ? value : [value];
  /** @type {string[]} */
  const parts = [];
  let deferred = false;
  for (const entry of entries) {
    const text = briefingText(entry);
    if (text === undefined) return undefined;
    if (isDeferred(text)) {
      deferred = true;
    } else if (text !== '') {
      parts.push(text);
    }
  }
  return deferred && parts.length === 0 ? undefined : parts;
}

/** @param {unknown} value @returns {string|undefined} */
function fichaText(value) {
  return briefingParts(value)?.join(', ');
}

// ADR 020: a briefing technique reaches the item's "Técnica" only when it
// names one, or says the garment is plain; "estampada", "com foto" or a
// description stay with the seller as service data.
const TECHNIQUE =
  /(^|[^a-z0-9])(silk|silk ?screen|serigrafia|sublimacao|sublimatica|sublimad[oa]|dtf|dtg|bordad[oa]s?|transfer)($|[^a-z0-9])/u;
export const NO_PRINT = 'Sem estampa';

/** @param {unknown} value @returns {string|undefined} */
function techniqueText(value) {
  const text = fichaText(value);
  if (!text) return undefined;
  if (isPlain(text)) return NO_PRINT;
  return TECHNIQUE.test(foldText(text)) ? text : undefined;
}

/**
 * Where the print goes, kept as the item's print reference. A plain garment
 * has no place: the answer is taken, and the item keeps no reference.
 *
 * @param {unknown} value
 */
function artworkPlaces(value) {
  const text = fichaText(value);
  if (text === undefined) return undefined;
  return isPlain(text) ? '' : text;
}

const NO_PRINT_ANSWER =
  /\bsem (estampa|aplicacao)\b|\bnao (tem|tera|vai ter|quer) estampa\b/u;
const ART_WORD = String.raw`.{0,20}\b(arte|logo|logotipo|desenho|imagem|arquivo)`;
const CUSTOMER_HAS_ART = new RegExp(
  String.raw`\b(ja tem|tem|tenho|temos|possui|possuo)\b${ART_WORD}|\b(pront[ao]s?|mand\w*|envi\w*|receb\w*)\b`,
  'u',
);
const LACKS_ART = String.raw`\bnao (tem|tenho|temos|possui|possuo)\b${ART_WORD}`;
const CUSTOMER_LACKS_ART = new RegExp(LACKS_ART, 'u');
const CUSTOMER_LACKS_ART_ALL = new RegExp(LACKS_ART, 'gu');
const SILMER_CREATES =
  /\b(silmer|cri(a|e|am|em|ar|ando|acao|ada|ado|ara|arao)|desenv\w*)\b/u;

/**
 * ADR 020: who makes the art, read from the bot's `artwork_status` only when
 * the answer leaves no doubt ("já tem a logo", "vai mandar", "quer que a
 * Silmer crie", "sem aplicação"). Anything else ("com estampa", "a definir")
 * stays as service data for the seller.
 *
 * @param {unknown} value
 * @returns {Pick<FichaArtwork, 'feito_pelo_cliente'|'feito_pela_silmer'|'sem_estampa'>|undefined}
 */
function artworkOrigin(value) {
  const text = fichaText(value);
  if (!text) return undefined;
  const folded = foldText(text);
  if (isPlain(text) || NO_PRINT_ANSWER.test(folded)) {
    return {
      feito_pela_silmer: false,
      feito_pelo_cliente: false,
      sem_estampa: true,
    };
  }
  // "Não tem a logo" asks Silmer to create it and says nothing of a file.
  const feitoPelaSilmer =
    CUSTOMER_LACKS_ART.test(folded) || SILMER_CREATES.test(folded);
  const feitoPeloCliente = CUSTOMER_HAS_ART.test(
    folded.replace(CUSTOMER_LACKS_ART_ALL, ' '),
  );
  if (!feitoPelaSilmer && !feitoPeloCliente) return undefined;
  return {
    feito_pela_silmer: feitoPelaSilmer,
    feito_pelo_cliente: feitoPeloCliente,
    sem_estampa: false,
  };
}

/** @param {unknown} value @returns {GradeLine[]|undefined} */
function briefingGrade(value) {
  return parseSizes(value) ?? undefined;
}

// Words that only name the pieces next to the quantity said ("18 peças").
const PIECE_WORDS = new Set([
  'peca',
  'pecas',
  'pc',
  'pcs',
  'unidade',
  'unidades',
  'un',
  'und',
  'unid',
]);
// A product text that names more than one product ("camisetas e bonés"):
// the quantity said may be for all of them, so it is not the item's.
const SEVERAL_PRODUCTS = /[,;+/&]|\be\b/u;

/**
 * The quantity the customer said for an order of one item, when it reads
 * without doubt: one whole number from 1 to 100000, alone or followed by one
 * word that names the pieces — "peças", "unidades" or a word of the item's
 * own type ("18 coletes" for "coletes"). "Cerca de 18", "18 a 20", "2
 * dúzias", "18 por tamanho" or the seller's placeholder read as nothing, and
 * the text stays only as service data.
 *
 * @param {unknown} value
 * @param {string[]} typeWords the folded words of the item's type
 * @returns {number|undefined}
 */
function saidQuantity(value, typeWords) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) &&
      value > 0 &&
      value <= MAX_INFORMED_QUANTITY
      ? value
      : undefined;
  }
  if (typeof value !== 'string' || value.length > MAX_TEXT) return undefined;
  const words = foldText(value)
    .replace(/[.!]+$/u, '')
    .split(/\s+/u);
  const [digits, unit, ...rest] = words;
  if (rest.length > 0 || !/^\d{1,6}$/u.test(digits ?? '')) return undefined;
  if (unit !== undefined) {
    const piece =
      PIECE_WORDS.has(unit) ||
      typeWords.some((word) => word === unit || `${word}s` === unit);
    if (!piece) return undefined;
  }
  const count = Number(digits);
  return count > 0 && count <= MAX_INFORMED_QUANTITY ? count : undefined;
}

/**
 * The folded words of the briefing's product texts, or null when they name
 * more than one product.
 *
 * @param {Record<string, unknown>} source
 * @returns {string[]|null}
 */
function productWords(source) {
  /** @type {string[]} */
  const words = [];
  for (const key of ['product_model', 'product_type']) {
    const text = fichaText(source[key]);
    if (!text) continue;
    const folded = foldText(text);
    if (SEVERAL_PRODUCTS.test(folded)) return null;
    words.push(
      ...folded
        .split(/\s+/u)
        .map((word) => word.replace(/s$/u, ''))
        .filter((word) => word.length > 2),
    );
  }
  return words;
}

/**
 * ADR 016/020: maps the agent pre-ficha onto the order without guessing. The
 * item points land on the first item — type of garment (`product_model`,
 * else `product_type`), colour, a named technique, fabric, sizes when they
 * read without doubt and collar — with the places of the print as its
 * reference. Who makes the art lands on the order when the answer is
 * unambiguous, and the order name on the summary. A point left to the seller
 * ("Definir com o vendedor") is never a ficha value: the field stays blank,
 * so it keeps blocking the order, and the text stays as service data. So
 * does anything else the bot collected, including the quantity the customer
 * said. ADR 025: a split by audience read without doubt gives one item per
 * audience instead, each with its audience and quantity said. Without a
 * split, a quantity said for one product that reads without doubt ("18",
 * "18 coletes") is also the quantity said of the one item; it never fills
 * the grade.
 *
 * @param {Record<string, unknown>|null|undefined} briefing
 * @returns {Ficha}
 */
export function briefingToFicha(briefing) {
  const source = isPlainObject(briefing) ? briefing : {};
  /** @type {Set<string>} */
  const consumed = new Set();
  /** @template T @param {string} key @param {(value: unknown) => T|undefined} read @returns {T|undefined} */
  const take = (key, read) => {
    if (source[key] === undefined || source[key] === null) {
      consumed.add(key);
      return undefined;
    }
    const value = read(source[key]);
    if (value !== undefined) consumed.add(key);
    return value;
  };

  const cliente = take('customer_name', fichaText) ?? '';
  const nome = take('order_name', fichaText) || null;
  // The type of garment is what the bot asks; the kind of product only
  // stands in for it when the customer never said the type.
  const tipo =
    take('product_model', fichaText) || take('product_type', fichaText);
  const origin = take('artwork_status', artworkOrigin);
  // ADR 025: a split read without doubt makes one item per audience. Several
  // items share the points, but not the sizes: those stay as service data for
  // the seller to share out.
  const split = take(
    'audiences',
    (value) => parseAudiences(value) ?? undefined,
  );
  const severalItems = (split?.length ?? 0) > 1;

  /** @type {FichaItem} */
  const item = {
    ...blankItem(),
    cor: take('colors', fichaText) ?? '',
    gola: take('collar', fichaText) ?? '',
    grade: severalItems ? [] : (take('sizes', briefingGrade) ?? []),
    malhas: take('fabrics', briefingParts) ?? [],
    tipo: tipo ?? '',
    tipo_servico: take('artwork_technique', techniqueText) ?? '',
  };
  const hasItem =
    item.tipo_servico !== '' ||
    ITEM_BRIEFING_KEYS.some(
      (key) => source[key] !== undefined && source[key] !== null,
    );
  if (hasItem) item.estampa = take('artwork_locations', artworkPlaces) ?? '';
  // The quantity said for an order of one item, without a split by audience
  // (said or still to read) and for one product, is that item's quantity
  // said. The text stays as service data too: it keeps the customer's words
  // and the order-wide check of PIT-09.
  const typeWords = productWords(source);
  const audiencesSaid =
    source.audiences !== undefined &&
    source.audiences !== null &&
    !(typeof source.audiences === 'string' && source.audiences.trim() === '');
  const quantidade =
    split || audiencesSaid || typeWords === null
      ? null
      : (saidQuantity(source.quantity, typeWords) ?? null);
  /** @type {FichaItem[]} */
  const items = !hasItem
    ? []
    : (split ?? [{ publico: '', quantidade }]).map((part) => ({
        ...structuredClone(item),
        publico: part.publico,
        quantidade_informada: part.quantidade,
      }));

  /** @type {Record<string, unknown>} */
  const serviceData = {};
  for (const [key, value] of Object.entries(source)) {
    if (consumed.has(key) || BRIEFING_INTERNAL_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    serviceData[key] = structuredClone(value);
  }

  return {
    artwork: { ...blankArtwork(), ...origin },
    items,
    observations: [],
    serviceData,
    summary: {
      // ADR 020: the order-wide technique is legacy; the bot no longer
      // writes it.
      aplicacao: null,
      cliente,
      data_entrega_confirmada: null,
      nome,
    },
  };
}

/**
 * What the bot says lands on an item it projected before: a point the
 * briefing has replaces the item's, the technique only fills a blank one
 * (ADR 020), and the seller's extras stay.
 *
 * @param {FichaItem} currentItem
 * @param {FichaItem} draftItem
 * @param {{keepGrade: boolean}} options
 * @returns {FichaItem}
 */
function mergeBotItem(currentItem, draftItem, { keepGrade }) {
  return {
    ...currentItem,
    cor: draftItem.cor || currentItem.cor,
    estampa: draftItem.estampa || currentItem.estampa,
    gola: draftItem.gola || currentItem.gola,
    grade:
      draftItem.grade.length > 0 || !keepGrade
        ? draftItem.grade
        : currentItem.grade,
    malhas: draftItem.malhas.length > 0 ? draftItem.malhas : currentItem.malhas,
    publico: draftItem.publico || currentItem.publico,
    quantidade_informada:
      draftItem.quantidade_informada ?? currentItem.quantidade_informada,
    tipo: draftItem.tipo || currentItem.tipo,
    tipo_servico: currentItem.tipo_servico || draftItem.tipo_servico,
  };
}

/**
 * PIT-11 and ADR 018: who the order is for — the contact's confirmed name,
 * else the name the customer gave the bot, else blank for the seller. A
 * pending order reads it again on every read; generating writes it down.
 *
 * @param {{customerName: string|null, briefing: Record<string, unknown>|null}} context
 * @returns {string}
 */
export function orderClient(context) {
  if (context.customerName) return context.customerName;
  const { briefing } = context;
  return (isPlainObject(briefing) && fichaText(briefing.customer_name)) || '';
}

/**
 * PAG-01: re-applies the agent's cumulative pre-ficha onto a pending ficha.
 * Only what the agent collects moves — event name, the points and print
 * reference of the first item, and its technique and who makes the art while
 * they are blank — and only when the briefing has a value for it. The model,
 * the colour of each part, the trims, the confirmed delivery date,
 * observations, files and any further items are the seller's and stay as
 * they are.
 *
 * ADR 025: a split by audience makes the bot's items the leading items with
 * an audience (or the first item, before any split). A new split rebuilds
 * them, one per audience, keeping the technique the seller chose; items the
 * seller added after them stay. The grade of a rebuilt item is not carried
 * over, since the sizes said were for the whole order.
 *
 * @param {Ficha} ficha
 * @param {Record<string, unknown>|null|undefined} briefing
 * @returns {Ficha}
 */
export function projectBriefingOntoFicha(ficha, briefing) {
  const draft = briefingToFicha(briefing);
  const current = normalizeFicha(ficha);
  let items = current.items;
  if (draft.items.length > 1) {
    const leading = current.items.findIndex((item) => item.publico === '');
    const botItems =
      leading === -1 ? current.items.length : Math.max(leading, 1);
    items = [
      ...draft.items.map((draftItem, index) => {
        const currentItem = current.items[index];
        return index < botItems && currentItem
          ? mergeBotItem(currentItem, draftItem, { keepGrade: false })
          : draftItem;
      }),
      ...current.items.slice(Math.min(botItems, current.items.length)),
    ];
  } else if (draft.items.length === 1) {
    const [firstItem, ...otherItems] = current.items;
    const [draftItem] = draft.items;
    items = firstItem
      ? [mergeBotItem(firstItem, draftItem, { keepGrade: true }), ...otherItems]
      : [draftItem];
  }
  // ADR 020: likewise, the bot marks who makes the art only while the order
  // has no mark.
  const said = draft.artwork ?? blankArtwork();
  return {
    artwork:
      hasArtworkOrigin(said) && !hasArtworkOrigin(current.artwork)
        ? {
            ...blankArtwork(),
            ...current.artwork,
            feito_pela_silmer: said.feito_pela_silmer,
            feito_pelo_cliente: said.feito_pelo_cliente,
            sem_estampa: said.sem_estampa,
          }
        : current.artwork,
    items,
    observations: current.observations,
    serviceData: draft.serviceData,
    summary: {
      ...current.summary,
      cliente: current.summary.cliente || draft.summary.cliente,
      nome: draft.summary.nome ?? current.summary.nome,
    },
  };
}
