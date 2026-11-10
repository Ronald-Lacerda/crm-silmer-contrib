// FPI-01/02/10 (ADR 078): the sheets of the ficha per item. The document has
// no script, so the server decides what goes on each sheet from estimated
// heights in CSS pixels. Glyph widths are the largest advance measured for
// Poppins 400, 500 and 600, rounded up, so a line is never estimated narrower
// than it prints: the estimate costs a ruled line, not a page.

/** A4 portrait body: 1120px minus 32px of top and bottom padding. */
export const SHEET_BODY = 1056;

const FOOT = 24;
const PANEL_GAP = 8;
const PANEL_PADDING = 24;
const ROW_GAP = 8;
const LINE = 20;
const LABEL = 16;
const NOTES_MAX = 160;
const NOTES_WIDTH = 668;
const CONTROL_FIXED = PANEL_PADDING + 32 + 88 + 12;
// The plan keeps this much ruled area; the stylesheet allows less. The gap
// absorbs what the renderer lays out taller than estimated, on any platform.
const FREE_MIN = 96;
const FREE_MIN_COMPACT = 72;
// Continuation sheets may have no ruled area to give back.
const CONTINUATION_SLACK = 16;
const FREE_PANEL_MIN = PANEL_GAP + PANEL_PADDING + 16 + 56;
const CHECK_COLUMN = 32;
const CONTINUATION_TITLE = PANEL_GAP + PANEL_PADDING + 24;
const GRADE_NOTICE = 4 + LINE;
const LIST_TABLE_TOP = 4 + 2 + 24;
const LIST_TOTAL = 33;
const NOTE_PIECE_CHARS = 600;
const NOTE_PIECE_BREAKS = 20;

/** Pixels of n of the twelve 50px columns with their 8px gutters. */
const span = (/** @type {number} */ columns) =>
  50 * columns + 8 * (columns - 1);

/**
 * @typedef {{t: string, q: number}} GradeLine
 * @typedef {{lines: GradeLine[], height: number}} GradeUnit
 * @typedef {{list: boolean, units: GradeUnit[]}} GradeLayout
 * @typedef {{
 *   tipo: string, cor: string, aplicacao: string, malha: string,
 *   estampa: string, gola: string, viesGola: string, viesMangas: string,
 *   modelo: string, frente: string, costas: string, mangaDireita: string,
 *   mangaEsquerda: string, grade: GradeLine[], total: number,
 *   informed: number | null,
 * }} SheetItem
 * @typedef {{
 *   numero?: string, previsao?: string, orderTotal?: number,
 *   cliente: string, nome: string, vendedor: string, data: string,
 *   primeiro: string, entregue: string, fab: string, items: SheetItem[],
 *   notes: string[],
 * }} SheetOrder
 * @typedef {'r1' | 'r2' | 'r3' | 'r4'} RowKey
 * @typedef {{itemIndex: number, compact: boolean, kept: number, moved: RowKey[], gradeKept: number}} ItemPlan
 * @typedef {{itemIndex: number, compact: boolean, rows: RowKey[], grade: {from: number, to: number} | null}} CarriedSection
 * @typedef {{carries: boolean, compact: boolean, sections: CarriedSection[], notes: number[], free: boolean}} ExtraPlan
 */

const SPACE = 0.3;
const OUTSIDE_LATIN = 1;
const PICTOGRAPH = 1.4;
const ROUNDING = 1.01;
/** Largest advance in em of each ASCII glyph across the printed weights. */
const ADVANCE = Object.freeze({
  A: 0.72,
  B: 0.65,
  C: 0.78,
  D: 0.72,
  E: 0.54,
  F: 0.53,
  G: 0.78,
  H: 0.72,
  I: 0.28,
  J: 0.57,
  K: 0.67,
  L: 0.46,
  M: 0.9,
  N: 0.74,
  O: 0.79,
  P: 0.61,
  Q: 0.79,
  R: 0.65,
  S: 0.61,
  T: 0.58,
  U: 0.7,
  V: 0.72,
  W: 1.03,
  X: 0.69,
  Y: 0.64,
  Z: 0.58,
  a: 0.68,
  b: 0.68,
  c: 0.61,
  d: 0.68,
  e: 0.62,
  f: 0.35,
  g: 0.68,
  h: 0.67,
  i: 0.29,
  j: 0.28,
  k: 0.59,
  l: 0.28,
  m: 1.05,
  n: 0.67,
  o: 0.64,
  p: 0.68,
  q: 0.68,
  r: 0.41,
  s: 0.55,
  t: 0.39,
  u: 0.67,
  v: 0.6,
  w: 0.85,
  x: 0.54,
  y: 0.61,
  z: 0.49,
  '!': 0.36,
  '"': 0.37,
  '#': 0.89,
  $: 0.66,
  '%': 0.83,
  '&': 0.78,
  "'": 0.2,
  '(': 0.49,
  ')': 0.49,
  '*': 0.52,
  '+': 0.69,
  ',': 0.26,
  '-': 0.59,
  '.': 0.26,
  '/': 0.49,
  ':': 0.27,
  ';': 0.33,
  '<': 0.59,
  '=': 0.74,
  '>': 0.57,
  '?': 0.54,
  '@': 1.06,
  '[': 0.5,
  '\\': 0.76,
  ']': 0.5,
  '^': 0.68,
  _: 0.79,
  '`': 0.28,
  '{': 0.51,
  '|': 0.31,
  '}': 0.51,
  '~': 0.6,
});

/** @param {string} char */
function charEm(char) {
  if (/\s/u.test(char)) return SPACE;
  if (/\p{N}/u.test(char) && /[0-9]/u.test(char)) return 0.67;
  const direct = ADVANCE[/** @type {keyof typeof ADVANCE} */ (char)];
  if (direct !== undefined) return direct;
  const base = char.normalize('NFD')[0];
  const accented = ADVANCE[/** @type {keyof typeof ADVANCE} */ (base)];
  if (accented !== undefined) return accented;
  if (/\p{M}/u.test(char)) return 0;
  return /\p{Extended_Pictographic}/u.test(char) ? PICTOGRAPH : OUTSIDE_LATIN;
}

/** @param {string} text @param {number} font */
export function textWidth(text, font) {
  let em = 0;
  for (const char of text) em += charEm(char);
  return em * font * ROUNDING;
}

/**
 * @param {string} paragraph
 * @param {number} width
 * @param {number} font
 */
function paragraphLines(paragraph, width, font) {
  const words = paragraph.split(/\s+/u).filter(Boolean);
  if (words.length === 0) return 1;
  const space = font * SPACE * ROUNDING;
  let lines = 1;
  let used = 0;
  for (const word of words) {
    const length = textWidth(word, font);
    if (used > 0 && used + space + length <= width) {
      used += space + length;
      continue;
    }
    if (used > 0) {
      lines += 1;
      used = 0;
    }
    if (length <= width) {
      used = length;
      continue;
    }
    // overflow-wrap: anywhere breaks a token wider than the line, per glyph.
    for (const char of word) {
      const advance = charEm(char) * font * ROUNDING;
      if (used > 0 && used + advance > width) {
        lines += 1;
        used = 0;
      }
      used += advance;
    }
  }
  return lines;
}

/**
 * Lines a text takes. `preserve` matches `white-space: pre-wrap`: explicit
 * breaks and runs of spaces consume paper.
 *
 * @param {string} text
 * @param {number} width
 * @param {number} font
 * @param {{preserve?: boolean}} [options]
 */
export function textLines(text, width, font, options = {}) {
  if (!options.preserve) return paragraphLines(text, width, font);
  return text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .reduce((total, line) => {
      const expanded = line.replaceAll('\t', '        ');
      return (
        total +
        Math.max(
          paragraphLines(expanded, width, font),
          Math.ceil(textWidth(expanded, font) / width) || 1,
        )
      );
    }, 0);
}

/** Split only overlong notes; keep every character and its order. @param {string} note */
function notePieces(note) {
  const pieces = [];
  let piece = '';
  let size = 0;
  let breaks = 0;
  for (const char of note) {
    piece += char;
    size += 1;
    if (char === '\n' || char === '\r') breaks += 1;
    if (size >= NOTE_PIECE_CHARS || breaks >= NOTE_PIECE_BREAKS) {
      pieces.push(piece);
      piece = '';
      size = 0;
      breaks = 0;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/** @param {string[]} notes */
export function splitNotes(notes) {
  return notes.flatMap(notePieces);
}

/** @param {SheetOrder} order */
export function clientIsLong(order) {
  return [...order.vendedor].length > 40 || textWidth(order.fab, 14) > span(1);
}

/** @param {SheetItem} item */
export function itemDiverges(item) {
  return item.informed !== null && item.informed !== item.total;
}

/** A printed label wider than this reads as a list, not as a column. */
export const GRADE_LABEL_LIST = 14;

/** @param {GradeLine[]} grade */
function gradePerBlock(grade) {
  return grade.every((line) => [...line.t].length <= 4) ? 16 : 10;
}

/** @param {GradeLine[]} grade */
function gradeIsList(grade) {
  return grade.some((line) => [...line.t].length > GRADE_LABEL_LIST);
}

/**
 * The grade in the units that may travel to another sheet: list rows, or
 * whole blocks of the size table. A block never breaks.
 *
 * @param {GradeLine[]} grade
 * @returns {GradeLayout}
 */
export function gradeLayout(grade) {
  if (gradeIsList(grade)) {
    return {
      list: true,
      units: grade.map((line) => ({
        lines: [line],
        height: Math.max(33, textLines(line.t, 478, 14) * LINE),
      })),
    };
  }
  const perBlock = gradePerBlock(grade);
  const count = Math.ceil(grade.length / perBlock);
  const columns = count > 1 ? perBlock : grade.length;
  const cell = Math.max(1, Math.floor(546 / Math.max(1, columns)) - 5);
  const units = [];
  for (let block = 0; block < count; block += 1) {
    const lines = grade.slice(block * perBlock, (block + 1) * perBlock);
    const heads = Math.max(...lines.map((line) => textLines(line.t, cell, 13)));
    const counts = Math.max(
      ...lines.map((line) => textLines(String(line.q), cell, 14)),
    );
    units.push({
      lines,
      height: 2 + Math.max(24, heads * 16) + Math.max(28, counts * LINE) + 34,
    });
  }
  return { list: false, units };
}

/**
 * @param {SheetItem} item
 * @param {number} [keep] units of the grade printed on this sheet
 */
function gradeHeight(item, keep = Number.POSITIVE_INFINITY) {
  const { list, units } = gradeLayout(item.grade);
  if (units.length === 0) return 24 + LINE;
  const kept = Math.min(keep, units.length);
  const notice = kept < units.length ? GRADE_NOTICE : 0;
  if (kept === 0) return 24 + notice;
  const printed = units.slice(0, kept);
  if (list) {
    const rows = printed.reduce((sum, unit) => sum + unit.height, 0);
    return (
      24 +
      LIST_TABLE_TOP +
      rows +
      (kept === units.length ? LIST_TOTAL : 0) +
      notice
    );
  }
  return (
    24 +
    printed.reduce(
      (sum, unit, index) => sum + (index === 0 ? 4 : 8) + unit.height,
      0,
    ) +
    notice
  );
}

/** @param {string} text @param {number} width @param {number} font */
const field = (text, width, font) =>
  LABEL + textLines(text, width, font) * LINE;

/**
 * The quantity line wraps its badge when the numbers are long.
 *
 * @param {SheetItem} item
 * @param {number} orderTotal
 * @param {boolean} compact
 */
function quantityHeight(item, orderTotal, compact) {
  const width = (compact ? span(4) : span(3) * 2 + 8) - CHECK_COLUMN;
  const figures =
    textWidth(String(item.total), 18) +
    4 +
    textWidth(`de ${orderTotal} no pedido`, 14);
  const lines = figures > width ? 2 : 1;
  if (!itemDiverges(item)) return LABEL + lines * LINE;
  if (compact) return LABEL + lines * LINE + 36;
  const badge = 8 + 16 + 4 + textWidth(`Informada ${item.informed}`, 13) + 16;
  return LABEL + (figures + badge > width ? lines + 1 : lines) * LINE;
}

/** @param {SheetItem} item @param {boolean} compact @param {number} orderTotal */
function firstRow(item, compact, orderTotal) {
  const font = compact ? 13 : 14;
  const width = (compact ? span(4) : span(3)) - CHECK_COLUMN;
  return Math.max(
    field(item.tipo, width, font),
    field(item.cor, width, font),
    quantityHeight(item, orderTotal, compact),
  );
}

/**
 * The height of each block of the item, as the sheet draws it.
 *
 * @param {SheetItem} item
 * @param {boolean} compact
 * @param {number} [orderTotal]
 * @param {number} [gradeKeep]
 */
export function itemBlocks(item, compact, orderTotal = 0, gradeKeep) {
  const font = compact ? 13 : 14;
  const point = (compact ? span(4) : span(3)) - CHECK_COLUMN;
  const reference = compact ? span(4) : span(6);
  const third = span(3);
  const alert = !compact && itemDiverges(item) ? ROW_GAP + 36 : 0;
  return {
    r1: firstRow(item, compact, orderTotal),
    r2: Math.max(
      field(item.aplicacao, point, font),
      field(item.malha, point, font),
      field(item.estampa, reference, font),
    ),
    grade: gradeHeight(item, gradeKeep) + alert,
    r3: Math.max(
      field(item.gola, third - CHECK_COLUMN, font),
      field(item.viesGola, third, font),
      field(item.viesMangas, third, font),
      field(item.modelo, third, font),
    ),
    r4: Math.max(
      field(item.frente, third, font),
      field(item.costas, third, font),
      field(item.mangaDireita, third, font),
      field(item.mangaEsquerda, third, font),
    ),
  };
}

/** @param {SheetOrder} order */
function headHeight(order) {
  return (
    Math.max(
      48,
      LABEL + textLines(order.numero || '—', span(3), 24) * 32,
      LABEL + textLines(order.previsao || '—', span(3), 18) * 24,
    ) + 12
  );
}

/** @param {SheetOrder} order @param {boolean} compact */
function clientHeight(order, compact) {
  const font = compact ? 13 : 14;
  const halves =
    LABEL +
    Math.max(
      textLines(order.cliente, span(6), font),
      textLines(order.nome, span(6), font),
    ) *
      LINE;
  if (clientIsLong(order)) {
    return (
      halves +
      ROW_GAP +
      LABEL +
      Math.max(
        textLines(order.vendedor, span(6), font),
        textLines(order.fab, span(6), font),
      ) *
        LINE +
      ROW_GAP +
      LABEL +
      LINE
    );
  }
  return (
    halves +
    ROW_GAP +
    LABEL +
    Math.max(
      textLines(order.vendedor, span(3), font),
      textLines(order.data, span(3), font),
      textLines(order.primeiro, span(3), font),
      textLines(order.entregue, span(2), font),
      textLines(order.fab, span(1), font),
    ) *
      LINE
  );
}

const CONTINUE_LINE = LINE + 4;

/**
 * @param {number[]} heights
 * @param {number} kept
 */
function notesBlock(heights, kept) {
  if (heights.length === 0) return 12 + 20 + LINE;
  let body = 0;
  for (let index = 0; index < kept; index += 1) body += heights[index];
  return 12 + 20 + body + (kept < heights.length ? CONTINUE_LINE : 0);
}

const ROW_ORDER = /** @type {RowKey[]} */ (['r4', 'r3', 'r2', 'r1']);

/**
 * Item sheets first; one that cannot hold its data sends whole rows and then
 * whole blocks of the grade to a continuation sheet, always with a notice.
 *
 * @param {SheetOrder} order
 * @param {SheetItem} item
 * @param {number} itemIndex
 * @param {number[]} noteHeights
 * @returns {ItemPlan}
 */
function planItem(order, item, itemIndex, noteHeights) {
  const unitCount = gradeLayout(item.grade).units.length;
  /**
   * @param {boolean} compact
   * @param {number} kept
   * @param {Set<RowKey>} present
   * @param {number} gradeKeep
   */
  const total = (compact, kept, present, gradeKeep) => {
    const blocks = itemBlocks(item, compact, order.orderTotal, gradeKeep);
    const rows = [...present].map((key) => blocks[key]);
    const movedNotice = present.size < 4 ? ROW_GAP + LINE : 0;
    const body =
      rows.reduce((sum, height) => sum + height, 0) +
      blocks.grade +
      rows.length * ROW_GAP +
      movedNotice;
    return (
      headHeight(order) +
      PANEL_PADDING +
      clientHeight(order, compact) +
      12 +
      notesBlock(noteHeights, kept) +
      PANEL_GAP +
      PANEL_PADDING +
      body +
      PANEL_GAP +
      CONTROL_FIXED +
      (compact ? FREE_MIN_COMPACT : FREE_MIN) +
      FOOT
    );
  };
  const all = new Set(ROW_ORDER);
  let compact = false;
  let kept = noteHeights.length;
  for (const mode of [false, true]) {
    compact = mode;
    kept = noteHeights.length;
    while (
      kept > 0 &&
      (total(compact, kept, all, unitCount) > SHEET_BODY ||
        notesBlock(noteHeights, kept) > NOTES_MAX)
    ) {
      kept -= 1;
    }
    if (
      total(compact, kept, all, unitCount) <= SHEET_BODY &&
      (kept > 0 || noteHeights.length === 0)
    ) {
      break;
    }
  }
  /** @type {RowKey[]} */
  const moved = [];
  const present = new Set(ROW_ORDER);
  for (const key of ROW_ORDER) {
    if (total(compact, kept, present, unitCount) <= SHEET_BODY) break;
    present.delete(key);
    moved.unshift(key);
  }
  let gradeKept = unitCount;
  while (
    gradeKept > 0 &&
    total(compact, kept, present, gradeKept) > SHEET_BODY
  ) {
    gradeKept -= 1;
  }
  return { itemIndex, compact, kept, moved, gradeKept };
}

/**
 * @param {SheetOrder} order
 * @param {ItemPlan[]} plans
 * @param {number[]} noteHeights
 * @returns {ExtraPlan[]}
 */
function planExtras(order, plans, noteHeights) {
  const unitsOf = (/** @type {ItemPlan} */ plan) =>
    gradeLayout(order.items[plan.itemIndex].grade);
  const carried = plans.filter(
    (plan) =>
      plan.moved.length > 0 || plan.gradeKept < unitsOf(plan).units.length,
  );
  const notesLeft = plans.some((plan) => plan.kept < noteHeights.length);
  if (carried.length === 0 && !notesLeft) return [];
  /** @type {ExtraPlan[]} */
  const extras = [];
  let used = 0;
  const start = (/** @type {boolean} */ carries) => {
    /** @type {ExtraPlan} */
    const fresh = {
      carries,
      compact: carries,
      sections: [],
      notes: [],
      free: false,
    };
    extras.push(fresh);
    used =
      headHeight(order) + PANEL_PADDING + clientHeight(order, carries) + FOOT;
    return fresh;
  };
  let sheet = start(carried.length > 0);
  const hasContent = () => sheet.sections.length > 0 || sheet.notes.length > 0;
  /** A new sheet when `need` does not fit and this one already holds content. */
  const makeRoom = (
    /** @type {number} */ need,
    /** @type {boolean} */ carries,
  ) => {
    if (used + need <= SHEET_BODY - CONTINUATION_SLACK || !hasContent())
      return false;
    sheet = start(carries);
    return true;
  };
  for (const plan of carried) {
    const blocks = itemBlocks(
      order.items[plan.itemIndex],
      plan.compact,
      order.orderTotal,
    );
    const open = () => {
      /** @type {CarriedSection} */
      const section = {
        itemIndex: plan.itemIndex,
        compact: plan.compact,
        rows: [],
        grade: null,
      };
      sheet.sections.push(section);
      return section;
    };
    /** @type {CarriedSection | null} */
    let section = null;
    for (const key of plan.moved) {
      const height = ROW_GAP + blocks[key];
      if (makeRoom((section ? 0 : CONTINUATION_TITLE) + height, true)) {
        section = null;
      }
      if (!section) {
        section = open();
        used += CONTINUATION_TITLE;
      }
      section.rows.push(key);
      used += height;
    }
    const { list, units } = unitsOf(plan);
    section = null;
    for (let index = plan.gradeKept; index < units.length; index += 1) {
      const last = index === units.length - 1;
      const cost = (/** @type {boolean} */ first) =>
        (list ? (first ? LIST_TABLE_TOP : 0) : first ? 4 : 8) +
        units[index].height +
        (list && last ? LIST_TOTAL : 0) +
        (first ? CONTINUATION_TITLE + ROW_GAP : 0);
      if (makeRoom(cost(!section), true)) section = null;
      const first = !section;
      if (!section) section = open();
      if (section.grade === null)
        section.grade = { from: index, to: index + 1 };
      else section.grade.to = index + 1;
      used += cost(first);
    }
  }
  noteHeights.forEach((height, index) => {
    const panel = sheet.notes.length === 0 ? PANEL_GAP + PANEL_PADDING + 20 : 0;
    makeRoom(panel + height + 4, false);
    if (sheet.notes.length === 0) used += PANEL_GAP + PANEL_PADDING + 20;
    sheet.notes.push(index);
    used += height + 4;
  });
  sheet.free = SHEET_BODY - used >= FREE_PANEL_MIN;
  return extras;
}

/**
 * @param {SheetOrder} order
 * @returns {{items: ItemPlan[], extras: ExtraPlan[]}}
 */
export function planFicha(order) {
  const noteHeights = order.notes.map(
    (note) => textLines(note, NOTES_WIDTH, 14, { preserve: true }) * LINE,
  );
  const items = order.items.map((item, itemIndex) =>
    planItem(order, item, itemIndex, noteHeights),
  );
  return { items, extras: planExtras(order, items, noteHeights) };
}
