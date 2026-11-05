import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createSizePricing,
  reviewSizePricingSubtotal,
} from '../../../modules/orders/src/domain/size-pricing.js';
import { exactCentPayload, EXACT_CENT_APPROVAL } from './exact-cent-proof.mjs';

export function exactCentFixture() {
  let n = 1;
  const specs = [
    [
      ['new-M', 3, 3],
      ['new-G', 3, 6],
    ],
    [
      ['new-M', 1, 1],
      ['new-M', 1, 2],
      ['existing-M-from-C01', 1, 3],
      ['new-G', 1, 4],
    ],
    [
      ['new-M', 500, 500],
      ['new-G', 1, 1],
    ],
  ];
  const plan = {
    approval: EXACT_CENT_APPROVAL,
    maximumGets: 14,
    maximumPosts: 3,
    maximumOrderTotalCents: 520,
    date: '2026-11-05',
    referencePrefix: 'CRM-F1-CENT-20261105',
    accountDocument: '00000000000000',
    buyerDocument: '00000000000000',
    buyerId: '90',
    originId: '7',
    products: ['new-M', 'new-G', 'existing-M-from-C01'].map((resource, i) => ({
      resource,
      id: String(101 + i),
      sku: 'MOCK-' + i,
    })),
    orders: specs.map((rows, i) => {
      let groups = createSizePricing(
        rows.map(([resource, quantity]) => [
          { size: resource === 'new-G' ? 'G' : 'M', quantity },
        ]),
        () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
      );
      rows.forEach((row, j) => {
        groups = reviewSizePricingSubtotal(
          groups,
          groups[j].id,
          groups[j].lines[0].id,
          row[2],
        );
      });
      return {
        alias: 'C0' + (5 + i),
        reference: 'CRM-F1-CENT-20261105-C0' + (5 + i),
        groups,
        items: rows.map(([resource, quantity, subtotalCents]) => ({
          resource,
          quantity,
          subtotalCents,
        })),
      };
    }),
  };
  return {
    plan,
    approvedDigest: createHash('sha256')
      .update(JSON.stringify(plan))
      .digest('hex'),
  };
}
export function exactCentMock(plan, change = (_kind, x) => x) {
  const calls = [],
    created = new Map();
  const fetcher = async (url, init) => {
    const path = url.slice('https://api.tiny.com.br/public-api/v3'.length);
    calls.push({ path, method: init.method });
    assert.equal(init.redirect, 'error');
    let body,
      kind = 'preflight',
      status = 200;
    if (path === '/info') body = { cpfCnpj: plan.accountDocument };
    else if (path === '/contatos/90')
      body = { id: 90, cpfCnpj: plan.buyerDocument, situacao: 'B' };
    else if (path.startsWith('/produtos/')) {
      const p = plan.products.find((p) => p.id === path.split('/').at(-1));
      assert.ok(p);
      body = { id: Number(p.id), sku: p.sku, situacao: 'A' };
    } else if (path === '/pedidos' && init.method === 'POST') {
      kind = 'post';
      status = 201;
      const payload = JSON.parse(init.body);
      assert.equal(
        init.body,
        exactCentPayload(
          plan,
          plan.orders.find(
            (o) => o.reference === payload.ecommerce.numeroPedidoEcommerce,
          ),
        ),
      );
      const id = 201 + created.size;
      created.set(id, payload);
      body = { id };
    } else if (path.startsWith('/pedidos?')) {
      kind = 'list';
      const ref = new URL(url).searchParams.get('numeroPedidoEcommerce');
      const matches = [...created].filter(
        ([, p]) => p.ecommerce.numeroPedidoEcommerce === ref,
      );
      body = {
        itens: matches.map(([id, p]) => ({ id, ecommerce: p.ecommerce })),
        paginacao: { offset: 0, limit: 100, total: matches.length },
      };
    } else if (path.startsWith('/pedidos/')) {
      kind = 'detail';
      const id = Number(path.split('/').at(-1));
      const p = created.get(id);
      assert.ok(p);
      const total =
        p.itens.reduce(
          (sum, line) =>
            sum + Math.round(line.valorUnitario * 100) * line.quantidade,
          0,
        ) / 100;
      body = {
        id,
        situacao: 0,
        data: p.data,
        cliente: { id: p.idContato, cpfCnpj: plan.buyerDocument },
        ecommerce: p.ecommerce,
        itens: [...p.itens].reverse().map((line) => ({
          ...line,
          produto: {
            ...line.produto,
            sku: plan.products.find((p) => Number(p.id) === line.produto.id)
              .sku,
          },
        })),
        valorTotalProdutos: total,
        valorTotalPedido: total,
        valorDesconto: 0,
        valorFrete: 0,
      };
    } else assert.fail('Unexpected endpoint');
    const changed = change(kind, body, calls.length);
    if (changed instanceof Response) return changed;
    return new Response(JSON.stringify(changed), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetcher, calls };
}
