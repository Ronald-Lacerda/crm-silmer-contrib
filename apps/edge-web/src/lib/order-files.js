// ADR 023: what the page knows about an order's art files before asking the
// API. The API checks everything again; these checks only spare the seller a
// 10 MB upload that would be refused.

export const MAX_REFERENCES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 256 * 1024;
const THUMBNAIL_EDGE = 320;

/** Extension → how the page shows a file without a thumbnail. */
const KINDS = Object.freeze({
  ai: 'vector',
  cdr: 'vector',
  eps: 'vector',
  gif: 'raster',
  jpeg: 'raster',
  jpg: 'raster',
  pdf: 'pdf',
  png: 'raster',
  psd: 'raster',
  rar: 'archive',
  svg: 'vector',
  tif: 'raster',
  tiff: 'raster',
  webp: 'raster',
  zip: 'archive',
});

const THUMBNAILABLE = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp']);

export const ACCEPT = Object.keys(KINDS)
  .map((extension) => `.${extension}`)
  .join(',');
export const FORMATS_LABEL =
  'PNG, JPEG, WebP, GIF, CDR, PDF, SVG, AI, EPS, PSD, TIFF, ZIP e RAR';

/** @param {string} name */
export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** @param {string} extension */
export function kindOf(extension) {
  return /** @type {Record<string, string>} */ (KINDS)[extension] ?? 'other';
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })} MB`;
}

/**
 * Why a chosen file cannot go, or '' when it can.
 *
 * @param {{name: string, size: number}} file
 */
export function refusalFor(file) {
  const extension = extensionOf(file.name);
  if (!(extension in KINDS)) {
    return `“${file.name}” não foi enviado: o formato não é aceito. Use ${FORMATS_LABEL}.`;
  }
  if (file.size === 0) return `“${file.name}” não foi enviado: está vazio.`;
  if (file.size > MAX_FILE_BYTES) {
    return `“${file.name}” não foi enviado: tem ${formatBytes(file.size)} e o limite é 10 MB.`;
  }
  return '';
}

/**
 * What a refused upload means to the seller.
 *
 * @param {any} cause @param {string} name
 */
export function uploadErrorMessage(cause, name) {
  const code = String(cause?.code ?? '');
  if (code === 'FILE_TOO_LARGE') {
    return `“${name}” não foi enviado: o limite é 10 MB.`;
  }
  if (code === 'FILE_TYPE_NOT_ALLOWED') {
    return `“${name}” não foi enviado: o formato não é aceito.`;
  }
  if (code === 'FILE_CONTENT_MISMATCH') {
    return `“${name}” não foi enviado: o conteúdo não corresponde à extensão .${extensionOf(name)}.`;
  }
  if (code === 'FILE_LIMIT_REACHED') {
    return 'Limite de 5 arquivos atingido. Remova um para enviar outro.';
  }
  return fileErrorMessage(cause);
}

/** @param {any} cause */
export function fileErrorMessage(cause) {
  const status = Number(cause?.status);
  const code = String(cause?.code ?? '');
  if (code === 'ORDER_STATUS_CONFLICT') {
    return 'Este pedido já foi gerado. Reabra o pedido para mudar os arquivos.';
  }
  if (code === 'FILE_NOT_FOUND') return 'Este arquivo já foi removido.';
  if (status === 403) return 'Este pedido é de outro vendedor.';
  if (status === 0) return 'Sem conexão. Tente de novo.';
  if (status >= 500) return 'Arquivos indisponíveis no momento. Tente de novo.';
  return 'Não foi possível concluir. Tente de novo.';
}

/**
 * A WebP of at most 320 px for PNG, JPEG and WebP, drawn here so the API
 * never decodes images. Any failure means "no thumbnail", never a refusal.
 *
 * @param {File} file
 * @returns {Promise<Blob|null>}
 */
export async function thumbnailFor(file) {
  if (!THUMBNAILABLE.has(extensionOf(file.name))) return null;
  try {
    const bitmap = await globalThis.createImageBitmap(file);
    const scale = Math.min(
      1,
      THUMBNAIL_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas
      .getContext('2d')
      ?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    /** @type {Blob|null} */
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.8),
    );
    return blob &&
      blob.type === 'image/webp' &&
      blob.size <= MAX_THUMBNAIL_BYTES
      ? blob
      : null;
  } catch {
    return null;
  }
}

/** @param {string} orderId @param {string} [fileId] */
export function filesUrl(orderId, fileId) {
  const base = `/api/v1/orders/${encodeURIComponent(orderId)}/files`;
  return fileId ? `${base}/${encodeURIComponent(fileId)}` : base;
}

/** @param {string} value */
export function uploadedAtLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
  const time = date.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
  return `${day} às ${time}`;
}
