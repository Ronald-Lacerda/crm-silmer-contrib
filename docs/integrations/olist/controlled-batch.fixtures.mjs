import assert from 'node:assert/strict';
// Invalid synthetic taxpayer identity. Mock fetch only; never sent externally.
export const input = () => ({
  approved: false,
  referencePrefix: 'CRM-F1-20261104',
  accountDocument: '00000000000000',
  customerSource: 'account-company-form',
  customer: {
    codigo: 'CRM-F1-20261104-CLI',
    nome: 'S M R SOLUCOES COMERCIO E INDUSTRIA LTDA',
    fantasia: 'SILMER',
    tipoPessoa: 'J',
    cpfCnpj: '00.000.000/0000-00',
    inscricaoEstadual: '000000000',
    regimeTributario: 1,
    situacao: 'B',
    endereco: {
      endereco: 'Rua Exemplo',
      numero: '1',
      bairro: 'Exemplo',
      municipio: 'Exemplo',
      uf: 'ES',
      cep: '00.000-000',
      complemento: '',
    },
  },
  existingBuyer: { id: 90, document: '11111111111111' },
  existingParentId: 10,
  existingM: { id: 11, sku: '29051-3' },
  existingG: { id: 12, sku: '29051-4' },
  originIntegratorIdCandidate: 777,
  date: '2026-11-04',
  newProductFiscal: { ncm: '6205.30.00', origem: 0, unidade: 'Un' },
});
const response = (x, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'x-ratelimit-remaining': '20',
    },
  });
const page = (x) => ({ itens: x, paginacao: { offset: 0, total: x.length } });
export function provider(plan, options = {}) {
  let customer = options.seedCreatedCustomer
      ? {
          ...input().customer,
          codigo: '',
          tipos: [{ id: 5, descricao: 'Cliente' }],
          id: 100,
        }
      : null,
    parent = Boolean(options.seedCreatedGG),
    gg = Boolean(options.seedCreatedGG);
  const orders = [],
    calls = [];
  if (options.seedRoundingOrders) {
    for (const [index, order] of plan.orders.slice(0, 2).entries()) {
      orders.push({
        id: 400 + index,
        data: '2026-11-04',
        situacao: 0,
        cliente: { id: 100, cpfCnpj: input().customer.cpfCnpj },
        ecommerce: { id: 777, numeroPedidoEcommerce: order.reference },
        itens: order.items.map((x) => ({
          produto: {
            id:
              x.resource === 'new-M' ? 201 : x.resource === 'new-G' ? 202 : 11,
          },
          quantidade: x.quantity,
          valorUnitario:
            Math.round((Number(x.unitLexeme) + Number.EPSILON) * 100) / 100,
        })),
        valorTotalPedido: order.hypotheticalTotalCents / 100,
        valorTotalProdutos: order.hypotheticalTotalCents / 100,
        idNotaFiscal: 0,
        pagamentosIntegrados: [],
        pagamento: { parcelas: [] },
      });
    }
    if (options.c03ProductProjectionDiffers)
      orders[1].valorTotalProdutos = 1.08;
    if (options.badC03Numeric) orders[1].itens[0].valorUnitario = 0.03;
  }
  const parentObject = () => ({
    id: 200,
    tipo: 'V',
    sku: plan.parent.payload.sku,
    situacao: 'A',
    unidade: 'Un',
    ncm: '62053000',
    origem: '0',
    precos: { preco: 0 },
    variacoes: (gg ? ['M', 'G', 'GG'] : ['M', 'G']).map((size, i) => ({
      id: 201 + i,
      sku: plan.parent.payload.sku + '-' + size,
      grade: [{ chave: 'Tamanho', valor: size }],
    })),
  });
  const newChild = (id, size) => ({
    id,
    sku: plan.parent.payload.sku + '-' + size,
    situacao: 'A',
    produtoPai: { id: 200 },
    precos: { preco: 0 },
  });
  return {
    calls,
    async fetch(url, init) {
      assert.equal(new URL(url).origin, 'https://api.tiny.com.br');
      const u = new URL(url),
        p = u.pathname.replace('/public-api/v3', '');
      const method = init.method;
      calls.push({ method, p });
      if (!init.headers.Authorization) {
        assert.equal(p, '/info');
        return response({}, 401);
      }
      assert.equal(init.headers.Authorization, 'Bearer MOCK');
      if (method === 'GET') {
        if (p === '/info')
          return response({ cpfCnpj: input().accountDocument });
        if (p === '/produtos/10')
          return response({
            id: 10,
            sku: '29051',
            tipo: 'V',
            variacoes: [
              {
                id: 11,
                sku: '29051-3',
                grade: [{ chave: 'Tamanho', valor: 'M' }],
              },
            ],
            unidade: 'Un',
            ncm: '62053000',
            origem: '0',
          });
        if (p === '/produtos/11')
          return response({
            id: 11,
            sku: '29051-3',
            situacao: 'A',
            produtoPai: { id: 10 },
            unidade: 'Un',
            ncm: '6205.30.00',
            origem: '0',
            precos: { preco: 34.9 },
          });
        if (p === '/contatos/90')
          return response({
            id: 90,
            cpfCnpj: input().existingBuyer.document,
            tipos: [{ id: 5, descricao: 'Cliente' }],
          });
        if (p === '/contatos/100') return response(customer);
        if (p === '/contatos') {
          let list =
            customer && u.searchParams.get('situacao') === 'B'
              ? [customer]
              : [];
          if (options.ambiguousCustomer)
            list = [
              {
                id: 101,
                cpfCnpj: input().customer.cpfCnpj,
                situacao: u.searchParams.get('situacao'),
              },
              {
                id: 102,
                cpfCnpj: input().customer.cpfCnpj,
                situacao: u.searchParams.get('situacao'),
              },
            ];
          return response(page(list));
        }
        if (p === '/produtos') {
          const sku = u.searchParams.get('codigo'),
            active = u.searchParams.get('situacao') === 'A';
          const products = parent
            ? [
                parentObject(),
                newChild(201, 'M'),
                newChild(202, 'G'),
                ...(gg ? [newChild(203, 'GG')] : []),
              ]
            : [];
          if (options.existingSku && sku === plan.parent.payload.sku && active)
            return response(page([{ id: 900, sku }]));
          return response(
            page(
              active
                ? products.filter((x) =>
                    options.partialProducts
                      ? x.sku.startsWith(sku)
                      : x.sku === sku,
                  )
                : [],
            ),
          );
        }
        if (p === '/produtos/200') return response(parentObject());
        if (p === '/produtos/201') return response(newChild(201, 'M'));
        if (p === '/produtos/202') return response(newChild(202, 'G'));
        if (p === '/produtos/203') return response(newChild(203, 'GG'));
        if (p === '/pedidos')
          return response(
            page(
              orders
                .filter(
                  (x) =>
                    x.ecommerce.numeroPedidoEcommerce ===
                    u.searchParams.get('numeroPedidoEcommerce'),
                )
                .map((x) => ({ id: x.id })),
            ),
          );
        if (/^\/pedidos\/4\d\d$/.test(p))
          return response(
            orders.find((x) => x.id === Number(p.split('/').at(-1))),
          );
        throw new Error('UNEXPECTED_MOCK_GET');
      }
      assert.equal(method, 'POST');
      const b = JSON.parse(init.body);
      if (p === '/contatos') {
        if (options.rejectCustomer)
          return response(
            {
              mensagem: 'Validacao',
              detalhes: [
                {
                  campo: 'cpfCnpj',
                  mensagem:
                    'Documento invalido 00.000.000/0000-00 SECRET_NOT_FOR_ARTIFACT',
                },
              ],
            },
            400,
          );
        assert.deepEqual(b.tipos, [5]);
        assert.equal(b.situacao, 'B');
        customer = {
          ...b,
          codigo: b.codigo ?? '100001',
          tipos: b.tipos.map((id) => ({ id, descricao: 'Cliente' })),
          id: 100,
        };
        return response({ id: 100 }, 201);
      }
      if (p === '/produtos') {
        if (options.timeoutParent) throw new Error('SIMULATED_TIMEOUT');
        parent = true;
        if (options.noParentId) return response({}, 201);
        return response(
          { id: 200, variacoes: [{ id: 201 }, { id: 202 }] },
          201,
        );
      }
      if (p === '/produtos/200/variacoes') {
        gg = true;
        return response({ id: options.ggReturnsParent ? 200 : 203 }, 201);
      }
      if (p === '/pedidos') {
        const index = orders.length,
          id = 400 + index,
          expected = plan.orders[index];
        const body = {
          id,
          data: b.data,
          situacao: 0,
          cliente: { id: b.idContato, cpfCnpj: input().customer.cpfCnpj },
          ecommerce: b.ecommerce,
          itens: b.itens,
          valorTotalProdutos: expected.hypotheticalTotalCents / 100,
          valorTotalPedido: expected.hypotheticalTotalCents / 100,
          idNotaFiscal: 0,
          pagamentosIntegrados: [],
          pagamento: { parcelas: [] },
        };
        if (options.dropReference && index === 0)
          body.ecommerce = { id: 0, numeroPedidoEcommerce: '' };
        orders.push(body);
        return response({ id }, 201);
      }
      throw new Error('UNEXPECTED_MOCK_POST');
    },
  };
}
