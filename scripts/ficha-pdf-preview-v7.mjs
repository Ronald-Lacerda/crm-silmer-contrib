// Synthetic review artifact for v7 (RFC 050). This script does not touch the
// immutable v2–v6 approval packages or change the live print switch.
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { chromium } from '@playwright/test';

import { renderFichaHtmlV7 } from '../modules/orders/src/print/ficha-canonical-v7.js';
import {
  TEMPLATE_V7,
  printSnapshot,
} from '../modules/orders/src/print/print-snapshot.js';

const snapshotUrl = new URL(
  '../docs/phase0/ficha-pdf-synthetic-v7.json',
  import.meta.url,
);
const artifactUrl = new URL(
  '../output/pdf/ficha-canonica-sintetica-v7.pdf',
  import.meta.url,
);
const approvalUrl = new URL(
  '../docs/phase0/ficha-pdf-approval-v7.json',
  import.meta.url,
);
// The preview may run again while the PO reviews the sample. Once the PO
// approves it, a new design requires a new template/package version.
const approved = await readFile(approvalUrl, 'utf8').then(
  (text) => JSON.parse(text).provisionalApproval?.status === 'approved',
  (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  },
);
if (approved) {
  throw new Error('Approved v7 PDF cannot be regenerated or overwritten');
}
const sample = JSON.parse(await readFile(snapshotUrl, 'utf8'));
if (sample.syntheticOnly !== true || sample.templateVersion !== TEMPLATE_V7) {
  throw new Error('Only the synthetic v7 sample may be rendered here');
}
const html = renderFichaHtmlV7(printSnapshot(sample.order, TEMPLATE_V7), {
  synthetic: true,
});
await mkdir(dirname(fileURLToPath(artifactUrl)), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    displayHeaderFooter: true,
    footerTemplate:
      '<div style="box-sizing:border-box;color:#657086;display:flex;font-family:Arial,sans-serif;font-size:7px;justify-content:space-between;padding:0 9mm;width:100%"><span>Amostra sintética v7 · não produzir</span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>',
    format: 'A4',
    headerTemplate: '<div></div>',
    landscape: true,
    path: fileURLToPath(artifactUrl),
    printBackground: true,
    preferCSSPageSize: true,
  });
} finally {
  await browser.close();
}
