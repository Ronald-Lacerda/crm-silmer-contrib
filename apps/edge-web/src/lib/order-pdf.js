/** The API's error code, when the failure carries a JSON body. @param {Response} response */
async function errorCode(response) {
  try {
    const body = await response.json();
    return typeof body?.error?.code === 'string' ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} orderId */
export async function getOrderPdf(orderId) {
  const response = await globalThis.fetch(
    `/api/v1/orders/${encodeURIComponent(orderId)}/pdf`,
    { credentials: 'same-origin', headers: { Accept: 'application/pdf' } },
  );
  if (!response.ok) {
    const error = new Error('PDF_UNAVAILABLE');
    /** @type {any} */ (error).status = response.status;
    /** @type {any} */ (error).code = await errorCode(response);
    throw error;
  }
  if (
    !(response.headers.get('content-type') ?? '').includes('application/pdf')
  ) {
    throw new Error('PDF_INVALID_RESPONSE');
  }
  return response.blob();
}

/** @param {Blob} blob @param {string} number */
export function pdfFile(blob, number) {
  return new globalThis.File([blob], `pedido-${number}.pdf`, {
    type: 'application/pdf',
  });
}

/** @param {File} file */
export function downloadPdf(file) {
  const url = globalThis.URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 60_000);
}

export function canSharePdf() {
  if (!globalThis.navigator?.share || !globalThis.navigator?.canShare)
    return false;
  try {
    return globalThis.navigator.canShare({
      files: [
        new globalThis.File(['%PDF'], 'ficha.pdf', { type: 'application/pdf' }),
      ],
    });
  } catch {
    return false;
  }
}

/** @param {File} file @param {string} number */
export async function sharePdf(file, number) {
  await globalThis.navigator.share({
    files: [file],
    title: `Ficha do pedido ${number}`,
  });
}
