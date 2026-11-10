import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PRINT_TEMPLATE,
  TEMPLATE_V2,
  TEMPLATE_V3,
  TEMPLATE_V4,
  TEMPLATE_V5,
  TEMPLATE_V6,
  TEMPLATE_V7,
  TEMPLATE_V8,
  renderOrderFicha,
} from '../modules/orders/src/print/index.js';

const rootUrl = new URL('../', import.meta.url);

test('the print route alone permits the exact styles of supported ficha templates', async () => {
  const nginx = await readFile(new URL('docker/nginx.conf', rootUrl), 'utf8');
  const fixture = JSON.parse(
    await readFile(
      new URL('docs/phase0/ficha-pdf-synthetic-v4.json', rootUrl),
      'utf8',
    ),
  );
  const routePolicy =
    /map \$uri \$print_style_sources \{\s*default "";\s*~\^\/api\/v1\/orders\/\[\^\/\]\+\/print\$ "([^"]+)";\s*\}/u.exec(
      nginx,
    );

  assert.ok(routePolicy, 'only the print path adds stylesheet hashes');
  assert.match(nginx, /style-src 'self' \$print_style_sources" always;/u);
  assert.doesNotMatch(nginx, /unsafe-inline/u);
  // ADR 078: v8 embeds its fonts; only the print path may load data: fonts.
  const fontPolicy =
    /map \$uri \$print_font_sources \{\s*default "";\s*~\^\/api\/v1\/orders\/\[\^\/\]\+\/print\$ "data:";\s*\}/u.exec(
      nginx,
    );
  assert.ok(fontPolicy, 'only the print path adds data: fonts');
  assert.match(nginx, /font-src 'self' \$print_font_sources;/u);
  assert.equal((nginx.match(/font-src/gu) ?? []).length, 1);

  const permittedHashes = new Set(routePolicy[1].split(' '));
  for (const template of [
    TEMPLATE_V2,
    TEMPLATE_V3,
    TEMPLATE_V4,
    TEMPLATE_V5,
    TEMPLATE_V6,
    TEMPLATE_V7,
    TEMPLATE_V8,
  ]) {
    // v8 refuses explicit financial text in the fixture's observations.
    const printableOrder = structuredClone(fixture.order);
    if (template === TEMPLATE_V8) {
      printableOrder.ficha.observations = ['Amostra sintética de produção.'];
    }
    const html = renderOrderFicha(printableOrder, template);
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/gu)];
    assert.equal(styles.length, 1, `${template} has one static style block`);
    assert.doesNotMatch(
      html,
      /\sstyle=/iu,
      `${template} has no style attributes`,
    );
    const anotherOrder = structuredClone(printableOrder);
    anotherOrder.number = '26-CRM';
    anotherOrder.ficha.summary.cliente = 'Outra cliente sintética';
    const otherStyles = [
      ...renderOrderFicha(anotherOrder, template).matchAll(
        /<style>([\s\S]*?)<\/style>/gu,
      ),
    ];
    assert.equal(
      otherStyles[0]?.[1],
      styles[0][1],
      `${template} stylesheet is independent of order data`,
    );
    const hash = createHash('sha256')
      .update(styles[0][1], 'utf8')
      .digest('base64');
    assert.ok(
      permittedHashes.has(`'sha256-${hash}'`),
      `${template} must have its current CSS hash in the print CSP`,
    );
  }
  assert.ok(
    [
      TEMPLATE_V2,
      TEMPLATE_V3,
      TEMPLATE_V4,
      TEMPLATE_V5,
      TEMPLATE_V6,
      TEMPLATE_V7,
      TEMPLATE_V8,
    ].includes(PRINT_TEMPLATE),
    'the active template must be included in the permitted set',
  );
  // ADR 027: the site shop's simplified ficha, picked by the order origin.
  const storeOrder = {
    ficha: {
      items: [{ cor: 'Preto', grade: [{ quantidade: 10, tamanho: 'M' }] }],
      loja: { telefone: '5527900000001' },
      summary: { cliente: 'Cliente sintética' },
    },
    isTest: false,
    number: '27-CRM',
    origin: 'loja',
  };
  const storeHtml = renderOrderFicha(storeOrder);
  const storeStyles = [...storeHtml.matchAll(/<style>([\s\S]*?)<\/style>/gu)];
  assert.equal(storeStyles.length, 1, 'the store ficha has one style block');
  assert.doesNotMatch(storeHtml, /\sstyle=/iu);
  const otherStore = renderOrderFicha({
    ...storeOrder,
    isTest: true,
    number: '28-CRM',
  });
  assert.equal(
    [...otherStore.matchAll(/<style>([\s\S]*?)<\/style>/gu)][0]?.[1],
    storeStyles[0][1],
    'the store stylesheet is independent of order data',
  );
  const storeHash = createHash('sha256')
    .update(storeStyles[0][1], 'utf8')
    .digest('base64');
  assert.ok(
    permittedHashes.has(`'sha256-${storeHash}'`),
    'ficha-loja-v1 must have its current CSS hash in the print CSP',
  );
  // ADR 031: for one release the print CSP also keeps the previous
  // ficha-loja-v1 stylesheet, because nginx (edge-web image) and the API
  // (runtime image) deploy separately. The next release removes it.
  assert.ok(
    permittedHashes.has(
      "'sha256-u7y0wEJXNxDpSaJ0qLl/zyxJ+y3teBfQYbrv469AXtE='",
    ),
    'the previous ficha-loja-v1 hash stays for one release',
  );
  assert.equal(
    permittedHashes.size,
    8,
    'no other inline stylesheet is allowed',
  );
});
