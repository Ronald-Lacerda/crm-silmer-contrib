// FPI-01..10 (ADR 078): one A4 portrait sheet per item, in the CRM's design
// system: the customer's data, the item and the production control on the same
// sheet, a line for the count under each size, and ruled room for handwriting.
// The document has no script, one static stylesheet and no style attribute, so
// the print CSP can admit it by hash. The v2–v7 renderers stay untouched.
import { POPPINS_FONT_FACES } from './ficha-v8-fonts.js';
import {
  clientIsLong,
  gradeLayout,
  itemDiverges,
  planFicha,
  splitNotes,
} from './ficha-v8-pages.js';
import { filledText } from './html.js';
import { NOT_APPLICABLE } from '../domain/ficha.js';

/** The seven production fields that remain on the sheet (FPI-07). */
export const PRODUCTION_FIELDS_V8 = Object.freeze([
  'conferido_arremate_por',
  'conferido_arremate_em',
  'arrematado_por',
  'arrematado_em',
  'observacao_arremate',
  'conferido_embalado_por',
  'conferido_embalado_em',
]);

const LOGO_PATH =
  'M50.1984 135.093C76.3095 135.093 95.6166 118.36 95.6166 96.295C95.6166 71.4713 80.1709 62.6448 50.9343 58.0477C24.0878 54.0018 19.3069 47.3827 19.3069 34.5111C19.3069 22.1911 28.685 13.1813 46.7053 13.1813C64.9091 13.1813 74.471 19.9846 77.597 36.5341H91.9392C89.3649 13.1813 72.9998 0.310046 46.7053 0.310046C21.8816 0.310046 4.41252 15.7561 4.41252 35.9825C4.41252 59.3347 20.7785 67.9774 48.3603 72.206C73.3676 76.2515 80.1709 82.5039 80.1709 97.3982C80.1709 112.292 67.1153 122.222 50.1984 122.222C23.7199 122.222 17.4679 108.983 15.4455 93.3527H0C2.38977 115.786 15.0777 135.093 50.1984 135.093ZM394.439 133.438H409.701V80.6649C409.701 56.9445 422.021 50.8766 441.329 49.957V35.6147C424.044 36.1659 415.769 43.7054 409.701 54.5542V37.2688H394.439V133.438ZM344.739 135.093C366.437 135.093 382.434 123.843 385.744 105.672H370.482C364.096 129.515 326.291 127.862 317.16 105.029C315.292 100.356 314.247 94.7873 314.032 88.3877H386.48V83.4234C386.48 49.0379 365.517 35.6147 343.268 35.6147C316.79 35.6147 298.218 55.8411 298.218 84.8937V86.3653C298.218 115.969 317.525 135.093 344.739 135.093ZM314.583 76.0677C317.157 58.9673 327.638 48.3021 343.268 48.3021C359.082 48.3021 369.379 56.2083 370.85 76.0677H314.583ZM152.226 133.438H167.488V74.597C167.488 57.3119 180.36 48.8538 192.863 48.8538C206.102 48.8538 213.273 55.8411 213.273 72.7582V133.438H228.535V74.597C228.535 57.3119 241.407 48.8538 253.911 48.8538C267.15 48.8538 274.321 55.8411 274.321 72.7582V133.438H289.583V73.8616C289.583 45.9115 274.505 35.6147 257.221 35.6147C245.269 35.6147 230.926 41.131 224.306 53.6348C219.342 40.7635 208.493 35.6147 196.173 35.6147C182.382 35.6147 171.9 42.97 167.488 51.9798V37.2688H152.226V133.438ZM127.963 133.438H143.408V5.77717e-05H127.963V133.438ZM103.515 133.438H118.777V37.2695H103.515V133.438ZM110.871 20.5366C116.387 20.5366 120.984 15.9395 120.984 10.4232C120.984 4.90689 116.387 0.309753 110.871 0.309753C105.354 0.309753 100.757 4.90689 100.757 10.4232C100.757 15.9395 105.354 20.5366 110.871 20.5366Z';

// Tokens from apps/edge-web/src/tokens.css (light theme); on paper every length
// sits on the product's 4px scale and twelve columns of 50px with 8px gutters.
const STYLE = `${POPPINS_FONT_FACES}
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
:root { --brand-primary: #ff5b01; --brand-ink: #0c042d; --color-surface: #ffffff; --color-surface-raised: color-mix(in srgb, var(--brand-ink) 4%, #ffffff); --color-text: var(--brand-ink); --color-text-muted: color-mix(in srgb, var(--brand-ink) 64%, #ffffff); --color-border: color-mix(in srgb, var(--brand-ink) 14%, #ffffff); --color-border-strong: color-mix(in srgb, var(--brand-ink) 45%, #ffffff); --status-warning-surface: #fff4d6; --status-warning-text: #7a4a00; --color-emphasis-surface: var(--brand-ink); --color-emphasis-text: color-mix(in srgb, var(--brand-ink) 6%, #ffffff); --color-emphasis-muted: color-mix(in srgb, var(--brand-ink) 30%, #ffffff); --color-emphasis-figure: color-mix(in srgb, var(--brand-primary) 70%, #ffffff); --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px; --text-xs: 13px; --text-sm: 14px; --text-lg: 18px; --text-2xl: 24px; --col: 50px; --gutter: 8px; --field-h: 32px; }
body { margin: 0; background: var(--color-surface); color: var(--color-text); font-family: Poppins, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; font-variant-numeric: tabular-nums; }
h1, h2, h3, p, ol { margin: 0; }
b, strong { font-weight: 600; }
@media screen { .sheet { margin: 0 auto; } }
.sheet { --val: var(--text-sm); text-rendering: geometricPrecision; display: flex; flex-direction: column; width: 210mm; min-height: 1120px; padding: 32px calc((210mm - 720px) / 2); background: var(--color-surface); color: var(--color-text); font-size: var(--text-sm); line-height: 20px; break-after: page; }
.sheet:last-of-type { break-after: auto; }
.sheet.compact { --val: var(--text-xs); }
.sheet.compact .r1 > *, .sheet.compact .r2 > * { grid-column: span 4; }
.sheet.compact .free { min-height: 44px; }
.lbl { display: block; font-size: var(--text-xs); line-height: 16px; font-weight: 500; color: var(--color-text-muted); }
.lbl b { font-weight: 600; color: var(--color-text); margin-right: 4px; }
.val { font-size: var(--val); line-height: 20px; font-weight: 400; overflow-wrap: anywhere; }
.val.b { font-weight: 600; }
.dash { font-weight: 400; color: var(--color-text-muted); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.g12, .row, .head { display: grid; grid-template-columns: repeat(12, var(--col)); column-gap: var(--gutter); }
.s1 { grid-column: span 1; } .s2 { grid-column: span 2; } .s3 { grid-column: span 3; } .s4 { grid-column: span 4; } .s6 { grid-column: span 6; }
.head { align-items: center; min-height: 48px; padding-inline: 16px; margin-bottom: 12px; }
.brand { display: flex; flex-direction: column; gap: 4px; }
.brand svg { display: block; height: 20px; width: auto; fill: var(--brand-primary); align-self: flex-start; }
.order strong { display: block; font-size: var(--text-2xl); line-height: 32px; overflow-wrap: anywhere; }
.due strong { display: block; font-size: var(--text-lg); line-height: 24px; overflow-wrap: anywhere; }
.tag { display: flex; flex-direction: column; justify-content: center; min-height: 48px; padding-inline: 12px; border-radius: var(--radius-lg); background: var(--color-emphasis-surface); color: var(--color-emphasis-text); }
.tag strong { font-size: var(--text-lg); line-height: 24px; white-space: nowrap; }
.tag strong i { font-style: normal; color: var(--color-emphasis-figure); }
.tag span { font-size: var(--text-xs); line-height: 16px; font-weight: 500; color: var(--color-emphasis-muted); }
.panel { border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: 11px 15px; background: var(--color-surface); }
.panel + .panel { margin-top: 8px; }
.client { row-gap: 8px; }
.c { min-width: 0; }
.item { display: flex; flex-direction: column; gap: 8px; }
.item-title { font-size: var(--text-lg); line-height: 24px; font-weight: 600; }
.pt { min-width: 0; }
.pt.has { display: grid; grid-template-columns: 24px 1fr; column-gap: 8px; align-items: start; }
.pt-b { min-width: 0; }
.check { position: relative; display: block; width: 24px; height: 24px; margin-top: 4px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-surface); }
.qty-line { display: flex; flex-wrap: wrap; align-items: center; column-gap: 4px; }
.qty-line strong { font-size: var(--text-lg); line-height: 20px; }
.qty-line .badge { margin-left: 8px; }
.badge { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding-inline: 8px; border-radius: var(--radius-sm); background: var(--status-warning-surface); color: var(--status-warning-text); font-size: var(--text-xs); line-height: 16px; font-weight: 500; white-space: nowrap; }
.sheet.compact .badge { height: auto; padding-block: 2px; white-space: normal; }
.ic { flex: none; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.grade-head { display: flex; align-items: center; gap: 8px; height: 24px; }
.grade-head .check { margin-top: 0; }
.grade-head .lbl { display: inline; }
.grade-head .hint { font-size: var(--text-xs); line-height: 16px; color: var(--color-text-muted); margin-left: 8px; }
.dt { margin-top: 4px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; break-inside: avoid; }
.dt + .dt { margin-top: 8px; }
table { border-collapse: separate; border-spacing: 0; table-layout: fixed; width: 100%; }
caption { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
col.c-label { width: 84px; }
col.c-total { width: 56px; }
th, td { position: relative; padding: 0 2px; text-align: center; font-size: var(--text-sm); line-height: 20px; font-weight: 400; border-left: 1px solid var(--color-border); overflow-wrap: anywhere; }
tr > :first-child { border-left: 0; }
th[scope="row"] { padding-left: 12px; text-align: left; font-size: var(--text-xs); line-height: 16px; font-weight: 500; color: var(--color-text-muted); }
tr.t th { height: 24px; background: var(--color-surface-raised); font-size: var(--text-xs); line-height: 16px; font-weight: 600; }
tr.t th[scope="row"] { font-weight: 500; }
tr.p td, tr.p th, tr.k td, tr.k th { border-top: 1px solid var(--color-border); }
tr.p td { height: 28px; font-weight: 600; }
tr.p th { height: 28px; }
tr.k td, tr.k th { height: 34px; }
tr.k th[scope="row"] { font-weight: 600; color: var(--color-text); }
td.spacer, th.spacer { border-left: 0; background: var(--color-surface); }
.list th[scope="col"] { height: 24px; background: var(--color-surface-raised); font-size: var(--text-xs); line-height: 16px; font-weight: 600; }
.list th[scope="col"]:first-child { text-align: left; padding-left: 12px; }
.list th[scope="col"]:nth-child(n+2) { width: 96px; }
.list tbody th, .list tbody td, .list tfoot th, .list tfoot td { height: 32px; border-top: 1px solid var(--color-border); font-weight: 600; }
.list tbody th[scope="row"] { color: var(--color-text); font-size: var(--val); }
.alert { display: flex; align-items: center; gap: 8px; min-height: 36px; margin-top: 8px; padding: 7px 11px; border: 1px solid var(--status-warning-text); border-radius: var(--radius-md); background: var(--status-warning-surface); color: var(--status-warning-text); font-size: var(--text-xs); line-height: 20px; font-weight: 600; }
.notes { margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--color-border); }
.notes.plain { margin-top: 0; padding-top: 0; border-top: 0; }
.notes h2 { font-size: var(--text-xs); line-height: 16px; font-weight: 500; color: var(--color-text-muted); margin-bottom: 4px; }
.notes-head { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 4px; }
.notes-head h2 { margin-bottom: 0; }
.notes-head strong { margin-left: 8px; color: var(--color-text); }
.notes ol { padding-left: 20px; font-size: var(--val); line-height: 20px; }
.notes li { overflow-wrap: anywhere; white-space: pre-wrap; }
.notes .none { font-size: var(--val); line-height: 20px; color: var(--color-text-muted); }
.more { margin-top: 4px; font-size: var(--text-xs); line-height: 20px; font-weight: 600; }
.item > .more { margin-top: 0; }
.control { display: flex; flex-direction: column; flex: 1 1 auto; }
.ctrl-head { display: flex; align-items: baseline; justify-content: space-between; height: 24px; margin-bottom: 8px; }
.ctrl-head h2 { font-size: var(--text-lg); line-height: 24px; font-weight: 600; }
.ctrl-head span { font-size: var(--text-xs); line-height: 16px; font-weight: 500; color: var(--color-text-muted); }
.stages { display: grid; grid-template-columns: 108px minmax(0, 1fr) 96px 108px minmax(0, 1fr) 96px; grid-template-rows: 16px repeat(2, var(--field-h)); gap: 4px var(--gutter); align-items: center; }
.cap { font-size: var(--text-xs); line-height: 16px; font-weight: 600; color: var(--color-text); }
.lb { font-size: var(--text-xs); line-height: 16px; font-weight: 500; color: var(--color-text-muted); }
.fld { position: relative; display: block; height: var(--field-h); border: 1px solid var(--color-border-strong); border-radius: var(--radius-md); background: var(--color-surface); }
.fld .fv { position: absolute; left: 8px; top: 5px; font-size: var(--text-sm); line-height: 20px; }
.stages .wide { grid-column: span 2; }
.date { display: flex; align-items: center; justify-content: space-evenly; }
.date .sep { color: var(--color-border-strong); font-size: var(--text-sm); line-height: 20px; }
.free { flex: 1 1 0; min-height: 64px; margin-top: 12px; display: flex; flex-direction: column; }
.free h3 { font-size: var(--text-xs); line-height: 16px; font-weight: 600; color: var(--color-text); }
.ruled { position: relative; flex: 1 1 0; min-height: 0; }
.lines { position: absolute; inset: 0; display: flex; flex-direction: column-reverse; overflow: hidden; }
.lines i { display: block; flex: none; height: 28px; border-bottom: 1px solid var(--color-border-strong); }
.extra .free-panel { flex: 1 1 0; min-height: 0; display: flex; }
.extra .free-panel .free { min-height: 0; margin-top: 0; }
.extra .notes-panel { flex: 0 0 auto; }
.extra .notes-panel li { margin-bottom: 4px; }
.foot { display: flex; justify-content: space-between; gap: 16px; margin-top: auto; padding: 8px 16px 0; font-size: var(--text-xs); line-height: 16px; font-weight: 500; color: var(--color-text-muted); }
.band { font-weight: 600; color: var(--color-text); white-space: nowrap; }
`;

/** @param {unknown} value */
function display(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** What the paper reads for a stored value. @param {unknown} value */
function printed(value) {
  const text = filledText(value);
  if (!text) return '—';
  return text === NOT_APPLICABLE ? 'NÃO APLICÁVEL' : text;
}

/** @param {unknown} value @param {boolean} [semibold] */
function value(value, semibold = false) {
  const text = printed(value);
  return `<div class="val${semibold ? ' b' : ''}">${text === '—' ? '<span class="dash">—</span>' : display(text)}</div>`;
}

/** The label already says FAB: print only the code. @param {unknown} code */
function fabCode(code) {
  return filledText(code).replace(/^fab\s*/iu, '');
}

/** @param {unknown} value */
function humanized(value) {
  const text = filledText(value);
  return text === NOT_APPLICABLE ? 'NÃO APLICÁVEL' : text;
}

/** @param {any} item */
function colorOf(item) {
  if (item.cor) return humanized(item.cor);
  return [...new Set([item.cor_frente, item.cor_costas].filter(Boolean))]
    .map(humanized)
    .join(' / ');
}

const AUDIENCE_LABELS = Object.freeze({
  feminino: 'Feminino',
  infantil: 'Infantil',
  masculino: 'Masculino',
  unissex: 'Unissex',
});

/** @param {any} item */
function audienceOf(item) {
  return (
    AUDIENCE_LABELS[
      /** @type {keyof typeof AUDIENCE_LABELS} */ (item.publico)
    ] ?? ''
  );
}

/** @param {any} artwork */
function artOf(artwork) {
  if (artwork?.sem_estampa) return 'Sem estampa';
  return [
    artwork?.feito_pelo_cliente ? 'O cliente envia a arte' : null,
    artwork?.feito_pela_silmer ? 'A Silmer cria a arte' : null,
  ]
    .filter(Boolean)
    .join(' e ');
}

/** @param {any} item @returns {import('./ficha-v8-pages.js').SheetItem} */
function sheetItem(item) {
  const grade = (Array.isArray(item.grade) ? item.grade : []).map(
    (/** @type {any} */ line) => ({
      t: String(line.tamanho ?? ''),
      q: Number(line.quantidade) || 0,
    }),
  );
  const total = grade.reduce(
    (/** @type {number} */ sum, /** @type {{q: number}} */ line) =>
      sum + line.q,
    0,
  );
  const informed =
    Number.isSafeInteger(item.quantidade_informada) &&
    item.quantidade_informada > 0
      ? item.quantidade_informada
      : null;
  return {
    tipo: printed(item.tipo),
    cor: printed(colorOf(item)),
    aplicacao: printed(item.tipo_servico),
    malha: printed(
      (Array.isArray(item.malhas) ? item.malhas : [])
        .map(humanized)
        .join(' / '),
    ),
    estampa: printed(item.estampa),
    gola: printed(item.gola || item.vies_gola),
    viesGola: printed(item.vies_gola),
    viesMangas: printed(item.vies_mangas),
    modelo: printed(item.modelo),
    frente: printed(item.cor_frente),
    costas: printed(item.cor_costas),
    mangaDireita: printed(item.cor_manga_direita),
    mangaEsquerda: printed(item.cor_manga_esquerda),
    grade,
    total,
    informed,
  };
}

const WARNING_ICON =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const RULES = '<i></i>'.repeat(38);

/** @param {string} label */
const check = (label) =>
  `<span class="check" role="img" aria-label="Caixa de conferência: ${display(label)}"></span>`;

/** @param {string} span @param {number} number @param {string} label @param {string} inner */
const point = (span, number, label, inner) =>
  `<div class="pt has ${span}">${check(label)}<div class="pt-b"><span class="lbl"><b>${number}</b>${display(label)}</span>${inner}</div></div>`;

/** @param {string} span @param {string} label @param {string} text @param {boolean} [semibold] */
const plain = (span, label, text, semibold = false) =>
  `<div class="pt ${span}"><span class="lbl">${display(label)}</span>${value(text, semibold)}</div>`;

/** @param {string} span @param {string} label @param {unknown} text @param {boolean} [semibold] */
const cell = (span, label, text, semibold = false) =>
  `<div class="c ${span}"><span class="lbl">${display(label)}</span>${value(text, semibold)}</div>`;

/**
 * The units [from, to) of the grade. Only the last one prints the total.
 *
 * @param {import('./ficha-v8-pages.js').SheetItem} item
 * @param {number} from
 * @param {number} to
 */
function gradeTables(item, from, to) {
  const { list, units } = gradeLayout(item.grade);
  if (units.length === 0) {
    return '<div class="val"><span class="dash">—</span></div>';
  }
  const slice = units.slice(from, to);
  if (slice.length === 0) return '';
  const lastSheet = to === units.length;
  if (list) {
    const rows = slice
      .flatMap((unit) => unit.lines)
      .map(
        (line) =>
          `<tr><th scope="row">${display(line.t)}</th><td>${display(line.q)}</td><td></td></tr>`,
      )
      .join('');
    const foot = lastSheet
      ? `<tfoot><tr><th scope="row">Total</th><td>${display(item.total)}</td><td></td></tr></tfoot>`
      : '';
    return `<div class="dt"><table class="list"><caption>Tamanhos, pedido e conferido</caption><thead><tr><th scope="col">Tamanho</th><th scope="col">Pedido</th><th scope="col">Conferido</th></tr></thead><tbody>${rows}</tbody>${foot}</table></div>`;
  }
  const many = units.length > 1;
  const perBlock = units[0].lines.length;
  return slice
    .map((unit, offset) => {
      const index = from + offset;
      const block = unit.lines;
      const last = index === units.length - 1;
      const missing =
        many && block.length < perBlock ? perBlock - block.length : 0;
      const filler = missing
        ? `<td class="spacer" colspan="${missing}"></td>`
        : '';
      const fillerHead = missing
        ? `<th class="spacer" colspan="${missing}"></th>`
        : '';
      const blank = '<td class="spacer"></td>';
      const columns = '<col>'.repeat(many ? perBlock : block.length);
      return `<div class="dt"><table><caption>Tamanhos, pedido e conferido${many ? `, bloco ${index + 1} de ${units.length}` : ''}</caption><colgroup><col class="c-label">${columns}<col class="c-total"></colgroup><tr class="t"><th scope="row">Tamanho</th>${block.map((line) => `<th scope="col">${display(line.t)}</th>`).join('')}${fillerHead}${last ? '<th scope="col">Total</th>' : blank}</tr><tr class="p"><th scope="row">Pedido</th>${block.map((line) => `<td>${display(line.q)}</td>`).join('')}${filler}${last ? `<td>${display(item.total)}</td>` : blank}</tr><tr class="k"><th scope="row">Conferido</th>${block.map(() => '<td></td>').join('')}${filler}${last ? '<td></td>' : blank}</tr></table></div>`;
    })
    .join('');
}

/**
 * @param {import('./ficha-v8-pages.js').SheetItem} item
 * @param {number} orderTotal
 * @param {boolean} compact
 * @returns {Record<'r1' | 'r2' | 'r3' | 'r4', string>}
 */
function itemRows(item, orderTotal, compact) {
  const diverges = itemDiverges(item);
  const badge = diverges
    ? `<span class="badge">${WARNING_ICON}<span>Informada ${display(item.informed)}${compact ? `, grade ${display(item.total)}: confirmar` : ''}</span></span>`
    : '';
  return {
    r1: `<div class="row r1">${point('s3', 1, 'Modelo', value(item.tipo, true))}${point('s3', 2, 'Cor', value(item.cor, true))}${point('s6', 3, 'Quantidade', `<div class="qty-line"><strong>${display(item.total)}</strong><span>de ${display(orderTotal)} no pedido</span>${badge}</div>`)}</div>`,
    r2: `<div class="row r2">${point('s3', 4, 'Aplicação', value(item.aplicacao, true))}${point('s3', 5, 'Modelo de malha', value(item.malha, true))}${plain('s6', 'Estampa (referência)', item.estampa, true)}</div>`,
    r3: `<div class="row r3">${point('s3', 7, 'Gola', value(item.gola, true))}${plain('s3', 'Viés da gola', item.viesGola)}${plain('s3', 'Viés das mangas', item.viesMangas)}${plain('s3', 'Detalhe do modelo', item.modelo, true)}</div>`,
    r4: `<div class="row r4">${plain('s3', 'Tecido frente', item.frente)}${plain('s3', 'Tecido costas', item.costas)}${plain('s3', 'Tecido manga direita', item.mangaDireita)}${plain('s3', 'Tecido manga esquerda', item.mangaEsquerda)}</div>`,
  };
}

/**
 * @param {import('./ficha-v8-pages.js').SheetItem} item
 * @param {number} keep
 * @param {boolean} compact
 * @param {string} notice
 */
function gradeBlock(item, keep, compact, notice) {
  const alert =
    itemDiverges(item) && !compact
      ? `<div class="alert">${WARNING_ICON}<span>Quantidade divergente: informada ${display(item.informed)}, grade soma ${display(item.total)}. Confirmar antes de produzir.</span></div>`
      : '';
  return `<div class="grade"><div class="grade-head">${check('Tamanhos')}<span class="lbl"><b>6</b>Tamanhos</span><span class="hint">Escrever a contagem em Conferido</span></div>${gradeTables(item, 0, keep)}${alert}${notice}</div>`;
}

/** @param {any} model @param {string} title @param {string} [sub] */
function head(model, title, sub) {
  const main = display(title).replace(
    /^(Item )(\d+)( de \d+)$/u,
    '$1<i>$2</i>$3',
  );
  return `<header class="head"><div class="brand s3"><svg viewBox="0 0 442 136" role="img" aria-label="Silmer"><path d="${LOGO_PATH}"/></svg><span class="lbl">Ficha de pedido</span></div><div class="order s3"><span class="lbl">Pedido</span><strong>${display(model.numero)}</strong></div><div class="due s3"><span class="lbl">Previsão de entrega</span><strong>${display(printed(model.previsao))}</strong></div><div class="tag s3"><strong>${main}</strong>${sub ? `<span>${display(sub)}</span>` : ''}</div></header>`;
}

/** @param {any} model @param {string} [notes] */
function clientPanel(model, notes = '') {
  const long = clientIsLong(model);
  const halves = `${cell('s6', 'Cliente', model.cliente, true)}${cell('s6', 'Nome do pedido', model.nome, true)}`;
  const seller = cell(long ? 's6' : 's3', 'Vendedor', model.vendedor);
  const fab = cell(long ? 's6' : 's1', 'FAB', model.fab);
  const days = long
    ? `${cell('s4', 'Data do pedido', model.data)}${cell('s4', 'Primeiro contato', model.primeiro)}${cell('s4', 'Entregue em', model.entregue)}`
    : `${cell('s3', 'Data do pedido', model.data)}${cell('s3', 'Primeiro contato', model.primeiro)}${cell('s2', 'Entregue em', model.entregue)}`;
  const body = long
    ? `${halves}${seller}${fab}${days}`
    : `${halves}${seller}${days}${fab}`;
  return `<section class="panel" aria-label="Dados do cliente"><div class="g12 client">${body}</div>${notes}</section>`;
}

/** @param {number[]} indexes @param {string[]} notes */
const noteList = (indexes, notes) =>
  `<ol>${indexes.map((index) => `<li value="${index + 1}">${display(notes[index])}</li>`).join('')}</ol>`;

/** @param {any} production @param {string} field @param {string} [extra] */
const writeField = (production, field, extra = '') =>
  `<div class="fld campo-producao-vazio${extra}"><span class="fv">${display(production[field])}</span></div>`;

/** @param {any} production @param {string} field */
const dateField = (production, field) =>
  `<div class="fld date campo-producao-vazio"><span class="fv">${display(production[field])}</span><span class="sep">/</span><span class="sep">/</span></div>`;

/** @param {any} production @param {string} annotationsTitle */
function controlPanel(production, annotationsTitle) {
  const cap =
    '<span class="cap">Etapa</span><span class="cap">Por</span><span class="cap">Data</span>';
  return `<section class="panel control" aria-label="Controle de produção"><div class="ctrl-head"><h2>Controle de produção</h2><span>Preencher à mão</span></div><div class="stages">${cap}${cap}<span class="lb">Conferido para arrematar</span>${writeField(production, 'conferido_arremate_por')}${dateField(production, 'conferido_arremate_em')}<span class="lb">Arrematado</span>${writeField(production, 'arrematado_por')}${dateField(production, 'arrematado_em')}<span class="lb">Conferido / Embalado</span>${writeField(production, 'conferido_embalado_por')}${dateField(production, 'conferido_embalado_em')}<span class="lb">OBS arremate</span>${writeField(production, 'observacao_arremate', ' wide')}</div><div class="free"><h3>${display(annotationsTitle)}</h3><div class="ruled" aria-hidden="true"><div class="lines">${RULES}</div></div></div></section>`;
}

/** @param {number} sheet @param {number} total @param {any} model @param {string} printedAt @param {boolean} synthetic */
function footer(sheet, total, model, printedAt, synthetic) {
  const version =
    model.versao === null ? '' : ` · versão ${display(model.versao)}`;
  const at = printedAt ? ` · impresso em ${display(printedAt)}` : '';
  return `<footer class="foot"><span>Folha ${sheet} de ${total}${version}${at}</span>${synthetic ? '<span class="band">Amostra sintética — não produzir</span>' : ''}</footer>`;
}

const PRINTED_AT = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
  month: '2-digit',
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
});

/** @param {Date | undefined} date */
function printedAtText(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  /** @type {Record<string, string>} */
  const part = {};
  for (const { type, value: piece } of PRINTED_AT.formatToParts(date)) {
    part[type] = piece;
  }
  return `${part.day}/${part.month}/${part.year} ${part.hour}:${part.minute}`;
}

/**
 * @param {any} snapshot
 * @param {{synthetic?: boolean, printedAt?: Date}} [options]
 * @returns {string}
 */
export function renderFichaHtmlV8(snapshot, options = {}) {
  const order = snapshot.pedido;
  const production = snapshot.producao;
  const rawItems = /** @type {any[]} */ (
    Array.isArray(order.itens) ? order.itens : []
  );
  const lastro = order.lastro ?? {};
  const notes = splitNotes(
    (Array.isArray(order.observacoes) ? order.observacoes : [])
      .map(filledText)
      .filter(Boolean),
  );
  const model = {
    numero: order.numero,
    previsao: order.data_entrega_confirmada,
    cliente: printed(order.cliente),
    nome: printed(order.nome),
    vendedor: printed(order.vendedor),
    data: printed(order.data),
    primeiro: printed(lastro.primeiro_contato),
    entregue: printed(lastro.entrega_realizada),
    fab: printed(fabCode(order.fab)),
    versao: Number.isSafeInteger(order.versao) ? order.versao : null,
    arte: printed(artOf(order.artwork)),
    orderTotal: order.quantidade_total,
    items: rawItems.map(sheetItem),
    notes,
  };
  const plan = planFicha(model);
  const itemCount = plan.items.length;
  const total = itemCount + plan.extras.length;
  const synthetic = options.synthetic === true;
  const printedAt = printedAtText(options.printedAt);
  const firstExtraWith = (/** @type {(extra: any) => boolean} */ test) => {
    const offset = plan.extras.findIndex(test);
    return offset < 0 ? 0 : itemCount + offset + 1;
  };
  const notesSheet = firstExtraWith((extra) => extra.notes.length > 0);
  const annotationsSheet = firstExtraWith((extra) => extra.free);
  const orderTotal = order.quantidade_total;
  const itemSheets = plan.items.map((itemPlan, index) => {
    const item = model.items[index];
    const rows = itemRows(item, orderTotal, itemPlan.compact);
    const rest = notes.length - itemPlan.kept;
    const body =
      notes.length === 0
        ? '<p class="none">—</p>'
        : itemPlan.kept > 0
          ? noteList(
              Array.from({ length: itemPlan.kept }, (_, note) => note),
              notes,
            )
          : '';
    const more =
      rest > 0
        ? `<p class="more">Continua na folha de observações (folha ${notesSheet} de ${total}): mais ${rest} observações</p>`
        : '';
    const notesBlock = `<section class="notes" aria-label="Observações do pedido"><div class="notes-head"><h2>Observações do pedido</h2><span class="lbl">Arte do pedido<strong>${display(model.arte)}</strong></span></div>${body}${more}</section>`;
    const present = /** @type {('r1' | 'r2' | 'r3' | 'r4')[]} */ ([
      'r1',
      'r2',
      'r3',
      'r4',
    ]).filter((key) => !itemPlan.moved.includes(key));
    const carriedSheet = firstExtraWith((extra) =>
      extra.sections.some(
        (/** @type {any} */ section) =>
          section.itemIndex === index && section.rows.length > 0,
      ),
    );
    const gradeSheet = firstExtraWith((extra) =>
      extra.sections.some(
        (/** @type {any} */ section) =>
          section.itemIndex === index && section.grade !== null,
      ),
    );
    const gradeNotice = gradeSheet
      ? `<p class="more">Os tamanhos deste item continuam na folha ${gradeSheet} de ${total}.</p>`
      : '';
    const movedNotice = itemPlan.moved.length
      ? `<p class="more">Parte dos dados deste item continua na folha ${carriedSheet} de ${total}.</p>`
      : '';
    const leading = present.filter((key) => key === 'r1' || key === 'r2');
    const trailing = present.filter((key) => key === 'r3' || key === 'r4');
    const itemHtml = `<section class="panel item" aria-label="Item ${index + 1}"><h2 class="sr">Item ${index + 1}${audienceOf(rawItems[index]) ? ` · ${display(audienceOf(rawItems[index]))}` : ''}</h2>${leading.map((key) => rows[key]).join('')}${gradeBlock(item, itemPlan.gradeKept, itemPlan.compact, gradeNotice)}${trailing.map((key) => rows[key]).join('')}${movedNotice}</section>`;
    const annotations = annotationsSheet
      ? `Anotações (continua na folha ${annotationsSheet} de ${total})`
      : 'Anotações';
    return `<article class="sheet${itemPlan.compact ? ' compact' : ''}">${head(model, `Item ${index + 1} de ${itemCount}`, audienceOf(rawItems[index]))}${clientPanel(model, notesBlock)}${itemHtml}${controlPanel(production, annotations)}${footer(index + 1, total, model, printedAt, synthetic)}</article>`;
  });
  const extraSheets = plan.extras.map((extra, offset) => {
    const carried = extra.sections
      .map((section) => {
        const rows = itemRows(
          model.items[section.itemIndex],
          orderTotal,
          section.compact,
        );
        if (section.grade) {
          return `<section class="panel item"><h2 class="item-title">Tamanhos (continuação) · Item ${section.itemIndex + 1}</h2><div class="grade">${gradeTables(model.items[section.itemIndex], section.grade.from, section.grade.to)}</div></section>`;
        }
        return `<section class="panel item"><h2 class="item-title">Item ${section.itemIndex + 1} · continuação</h2>${section.rows.map((key) => rows[key]).join('')}</section>`;
      })
      .join('');
    const notesPanel = extra.notes.length
      ? `<section class="panel notes-panel" aria-label="Observações do pedido"><div class="notes plain"><h2>Observações do pedido</h2>${noteList(extra.notes, notes)}</div></section>`
      : '';
    const annotations = extra.free
      ? `<section class="panel free-panel"><div class="free"><h3>Anotações (continuação) · Item ______</h3><div class="ruled" aria-hidden="true"><div class="lines">${RULES}</div></div></div></section>`
      : '';
    return `<article class="sheet extra${extra.compact ? ' compact' : ''}">${head(model, extra.carries ? 'Continuação' : 'Observações')}${clientPanel(model)}${carried}${notesPanel}${annotations}${footer(itemCount + offset + 1, total, model, printedAt, synthetic)}</article>`;
  });
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Ficha de Pedido ${display(order.numero)}</title>
  <style>${STYLE}</style>
</head>
<body>
<main>${itemSheets.join('')}${extraSheets.join('')}</main>
</body>
</html>`;
  return html;
}
