import {
  createOlistReconciliationRuntime,
  createOlistReconciliationHandler,
} from '../apps/worker/src/olist-reconciliation-runtime.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createApi } from '../apps/api/src/app.js';
import { createOlistApiRuntime } from '../apps/api/src/olist-runtime.js';
import { buildOlistPreviewPlan } from '../apps/api/src/olist-preview-plan.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { authorize } from '../modules/identity-access/src/index.js';
import {
  encryptContactDetails,
  encryptContactRegistration,
} from '../modules/contacts/src/index.js';
import {
  createSizePricing,
  reviewSizePricingSubtotal,
} from '../modules/orders/src/index.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import {
  EMPTY_OLIST_SETTINGS,
  identityHash,
  olistConfiguration,
  open,
  seal,
} from '../modules/olist/src/index.js';
import { syntheticArtwork, syntheticItems } from './fixtures/order-items.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-06T12:00:00.000Z');
const ORDER_KEY = Buffer.alloc(32, 71);
const CONTACT_KEY = Buffer.alloc(32, 72);
const environment = {
  APP_ORIGIN: 'https://crm.example.test',
  OLIST_ENABLED: 'true',
  OLIST_CLIENT_ID: 'synthetic-export-app',
  OLIST_CLIENT_SECRET: 'synthetic-export-secret',
  OLIST_REDIRECT_URI: 'https://crm.example.test/olist',
  OLIST_EXPECTED_ACCOUNT_DOCUMENT: '12345678000199',
  OLIST_ENVELOPE_KEY: Buffer.alloc(32, 73).toString('base64'),
  OLIST_IDENTITY_HMAC_KEY: Buffer.alloc(32, 74).toString('base64'),
  IDEMPOTENCY_ENVELOPE_KEY: Buffer.alloc(32, 75).toString('base64url'),
  N8N_INTEGRATION_ENVELOPE_KEY: ORDER_KEY.toString('base64'),
  CONTACT_IDENTITY_ENVELOPE_KEY: CONTACT_KEY.toString('base64'),
};
const settings = {
  ...EMPTY_OLIST_SETTINGS,
  sellerId: 11,
  operationNatureId: 12,
  warehouseId: 13,
  paymentMethodId: 14,
  originId: 15,
  paymentTerms: '30 dias',
  paymentDueOn: '2026-11-30',
  productFiscal: { ncm: '61091000', origin: 0, unit: 'UN' },
};
const registration = {
  personType: /** @type {const} */ ('individual'),
  instagram: null,
  stateRegistration: null,
  complement: null,
  document: '52998224725',
  legalName: 'Comprador Sintético',
  postalCode: '29010000',
  city: 'Vitória',
  state: 'ES',
  street: 'Rua de Teste',
  district: 'Centro',
  number: '12',
};
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');
if (!connectionString)
  test(
    'OLIST-T09 integrated API/PostgreSQL administration requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-T09: real administrative previews, links and queued reads have no ERP POST', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
      'Only the dedicated synthetic database may be reset',
    );
    const pool = new Pool({ connectionString, max: 12 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const config = olistConfiguration(environment);
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      let fixtureActorId = '';
      /** @param {{status?:string,subtotal?:number,legacy?:boolean,missingSeller?:boolean,changeDuringFetch?:()=>Promise<void>}} [patch] */
      async function fixture(patch = {}) {
        await pool.query('TRUNCATE crm.olist_accounts CASCADE');
        let current = new Date(NOW);
        /** @type {Record<string,any>} */
        const actors = {};
        for (const [role, functionName, enabled, admin] of [
          ['owner', 'Vendedor', false, false],
          ['finance', 'Financeiro', true, false],
          ['admin', 'Vendedor', false, true],
        ]) {
          const id = `preview-${role}-${randomUUID()}`,
            token = randomUUID();
          await pool.query(
            "INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version) VALUES($1,$2,'Conta sintética','$argon2id$synthetic',$3,$4)",
            [id, id + '@example.test', enabled, enabled ? 1 : 0],
          );
          await pool.query(
            'INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,$2)',
            [id, functionName],
          );
          if (admin)
            await pool.query(
              "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
              [id],
            );
          await pool.query(
            'INSERT INTO crm.sessions(token_hash,user_id,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES($1,$2,$3,$4,$4,$5)',
            [
              hash(token),
              id,
              hash('synthetic-csrf'),
              NOW,
              new Date(NOW.getTime() + 86400000),
            ],
          );
          actors[/** @type {string} */ (role)] = {
            actor: {
              id,
              kind: 'human',
              functionName,
              olistEnabled: enabled,
              olistAuthorizationVersion: enabled ? 1 : 0,
              capabilities: admin ? ['COMMERCIAL_ADMIN'] : [],
            },
            token,
            sessionBinding: hash(token),
            correlationId: 'synthetic-preview',
          };
        }
        await pool.query(
          'INSERT INTO crm.olist_accounts(account_key,creation_enabled,recovery_required) VALUES($1,false,true)',
          [config.accountKey],
        );
        await pool.query(
          'INSERT INTO crm.olist_settings(account_key,version,settings_envelope) VALUES($1,1,$2::jsonb)',
          [
            config.accountKey,
            JSON.stringify(
              seal(
                settings,
                config.envelopeKey,
                'settings',
                config.accountKey,
                'central',
              ),
            ),
          ],
        );
        await pool.query(
          'INSERT INTO crm.olist_connections(context_key,account_key,version,generation,token_envelope,expires_at) VALUES($1,$2,1,1,$3::jsonb,$4)',
          [
            config.contextKey,
            config.accountKey,
            JSON.stringify(
              seal(
                {
                  accessToken: 'synthetic-access',
                  refreshToken: 'synthetic-refresh',
                },
                config.envelopeKey,
                'tokens',
                config.accountKey,
                config.contextKey,
              ),
            ),
            new Date(NOW.getTime() + 3600000),
          ],
        );
        const orderId = randomUUID(),
          contactId = randomUUID();
        await pool.query(
          'INSERT INTO crm.contacts(id,display_name,contact_details_envelope,registration_envelope,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$5)',
          [
            contactId,
            'Comprador Sintético',
            JSON.stringify(
              encryptContactDetails(
                { phone: '5511999990000', email: 'buyer@example.test' },
                CONTACT_KEY,
              ),
            ),
            JSON.stringify(
              encryptContactRegistration(registration, CONTACT_KEY),
            ),
            NOW,
          ],
        );
        const item = syntheticItems()[0];
        item.grade = [{ tamanho: 'M', quantidade: 3 }];
        delete item.publico;
        let groups = createSizePricing([[{ size: 'M', quantity: 3 }]]);
        groups = reviewSizePricingSubtotal(
          groups,
          groups[0].id,
          groups[0].lines[0].id,
          patch.subtotal ?? 600,
        );
        const ficha = {
          summary: {
            cliente: 'Comprador Sintético',
            telefone: '5511999990000',
            nome: null,
            data_entrega_confirmada: '2026-11-20',
          },
          items: [item],
          artwork: syntheticArtwork(),
          observations: ['INTERNAL_SENTINEL'],
          serviceData: { secret: 'CONVERSATION_SENTINEL' },
          ...(patch.legacy ? {} : { sizePricing: groups }),
        };
        const orderStatus = patch.status ?? 'pendente';
        await pool.query(
          `WITH n AS(SELECT nextval('crm.order_number_seq') v) INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,status,fab_code,ficha_envelope,total_pieces,missing_fields,final_amount_cents,payment_condition,order_date,confirmed_at,confirmed_by,created_by_kind,created_by,created_at,updated_at) SELECT $1,v,lpad(v::text,2,'0')||'-CRM',NULL,$2,$3,$4,$5,'SYNTHETIC',$6::jsonb,3,'{}',$7,'pix',CASE WHEN $5='confirmado' THEN '2026-11-06'::date ELSE NULL END,$8,$9,'user',$3,$10,$10 FROM n`,
          [
            orderId,
            contactId,
            actors.owner.actor.id,
            randomUUID(),
            orderStatus,
            JSON.stringify(
              encryptJson(ficha, `order-ficha:${orderId}`, ORDER_KEY),
            ),
            patch.subtotal ?? 600,
            orderStatus === 'confirmado' ? NOW : null,
            orderStatus === 'confirmado' ? actors.owner.actor.id : null,
            NOW,
          ],
        );
        const source = {
          order: {
            id: orderId,
            status: orderStatus,
            origin: 'atendimento',
            ficha,
            finalAmountCents: patch.subtotal ?? 600,
            paymentCondition: 'pix',
            orderDate: orderStatus === 'confirmado' ? '2026-11-06' : null,
          },
          sourceRevision: 0,
          issues: [],
        };
        const plan = buildOlistPreviewPlan({
          source,
          buyer: {
            name: 'Comprador Sintético',
            phone: '5511999990000',
            email: 'buyer@example.test',
            registration,
          },
          settings,
          now: NOW,
        });
        /** @type {Map<string,any>} */
        const responses = new Map([
          [
            '/vendedores',
            {
              itens: [
                {
                  id: patch.missingSeller ? 999 : 11,
                  nome: 'Vendedor sintético',
                },
              ],
              paginacao: { offset: 0, total: 1, limit: 50 },
            },
          ],
          ['/depositos', [{ id: 13, nome: 'Depósito sintético' }]],
          [
            '/formas-pagamento',
            {
              itens: [{ id: 14, nome: 'Pagamento sintético' }],
              paginacao: { offset: 0, total: 1, limit: 50 },
            },
          ],
          [
            '/contatos/101',
            {
              id: 101,
              ...plan.customer,
            },
          ],
        ]);
        await pool.query(
          "INSERT INTO crm.olist_resources(id,account_key,kind,identity_hash,reference,state,remote_id) VALUES($1,$2,'customer',$3,$4,'confirmed','101')",
          [
            randomUUID(),
            config.accountKey,
            identityHash(config.hmacKey, 'customer', [
              config.accountKey,
              registration.document,
            ]),
            'CRM-' + randomUUID(),
          ],
        );
        for (const [i, group] of plan.commercial.groups.entries()) {
          const productId = randomUUID(),
            parent = 201 + i * 10,
            variation = parent + 1;
          const identity = [
            'garment',
            'color',
            'fabric',
            'application',
            'collar',
            'audience',
          ].map((key) =>
            group.attributes[key].normalize('NFC').toLocaleLowerCase('pt-BR'),
          );
          await pool.query(
            "INSERT INTO crm.olist_resources(id,account_key,kind,identity_hash,reference,state,remote_id) VALUES($1,$2,'product',$3,$4,'confirmed',$5)",
            [
              productId,
              config.accountKey,
              identityHash(config.hmacKey, 'product', [
                config.accountKey,
                identity,
              ]),
              'CRM-P-' +
                identityHash(config.hmacKey, 'product', [
                  config.accountKey,
                  identity,
                ]),
              String(parent),
            ],
          );
          const size = group.lines[0].size;
          await pool.query(
            "INSERT INTO crm.olist_resources(id,account_key,kind,identity_hash,reference,parent_id,state,remote_id) VALUES($1,$2,'variation',$3,$4,$5,'confirmed',$6)",
            [
              randomUUID(),
              config.accountKey,
              identityHash(config.hmacKey, 'variation', [
                config.accountKey,
                [productId, size.normalize('NFC').toLocaleLowerCase('pt-BR')],
              ]),
              'CRM-' + randomUUID(),
              productId,
              String(variation),
            ],
          );
          responses.set('/produtos/' + parent, {
            id: parent,
            tipo: 'V',
            situacao: 'A',
            sku:
              'CRM-P-' +
              identityHash(config.hmacKey, 'product', [
                config.accountKey,
                identity,
              ]),
            descricao: [
              'garment',
              'color',
              'fabric',
              'application',
              'collar',
              'audience',
            ]
              .map((key) => group.attributes[key])
              .filter((value) => value !== '')
              .join(' | '),
            variacoes: [
              {
                id: variation,
                sku: 'SYNTHETIC-M',
                grade: [{ chave: 'Tamanho', valor: size }],
              },
            ],
          });
          responses.set('/produtos/' + variation, {
            id: variation,
            sku: 'SYNTHETIC-M',
            tipoVariacao: 'V',
            situacao: 'A',
            produtoPai: { id: parent },
          });
        }
        const parentBody = responses.get('/produtos/201');
        Object.assign(parentBody, {
          sku: 'SYNTHETIC-LEGACY-P',
          ncm: '61091000',
          origem: 0,
          unidade: 'UN',
        });
        /** @type {any} */ const sale = {
          id: 401,
          numeroPedido: 9001,
          situacao: 0,
          data: '2026-11-06',
          dataPrevista: '2026-11-20',
          cliente: { id: 101, cpfCnpj: registration.document },
          ecommerce: { id: 15 },
          itens: [{ produto: { id: 202 }, quantidade: 3, valorUnitario: 2 }],
          valorTotalProdutos: 6,
          valorTotalPedido: 6,
        };
        responses.set('/pedidos/401', sale);
        /** @type {{url:string,method:string}[]} */
        const calls = [];
        const behavior = { changeDuringFetch: patch.changeDuringFetch };
        let changed = false;
        const fetcher = /** @type {typeof fetch} */ (
          async (url, init) => {
            calls.push({ url: String(url), method: init?.method ?? 'GET' });
            if (behavior.changeDuringFetch && !changed) {
              changed = true;
              await behavior.changeDuringFetch();
            }
            const path = new URL(String(url)).pathname.replace(
              '/public-api/v3',
              '',
            );
            const body = responses.get(path);
            assert.ok(body, 'Unexpected synthetic ERP request: ' + path);
            return new globalThis.Response(JSON.stringify(body), {
              headers: { 'content-type': 'application/json' },
            });
          }
        );
        /** @param {any} input @param {boolean} write */
        const authenticate = (input, write) => {
          const user = Object.values(actors).find((actor) =>
            String(input.cookie ?? '')
              .split(';')
              .some((part) => part.trim() === 'crm_session=' + actor.token),
          );
          if (!user || input.authorization !== undefined)
            throw Object.assign(new Error('FORBIDDEN'), {
              code: 'FORBIDDEN',
              statusCode: 403,
            });
          if (
            write &&
            (input.origin !== environment.APP_ORIGIN ||
              input.csrfToken !== 'synthetic-csrf')
          )
            throw Object.assign(new Error('CSRF_INVALID'), {
              code: 'CSRF_INVALID',
              statusCode: 403,
            });
          authorize(user.actor, input.action);
          return { actor: user.actor };
        };
        /** @type {(targetDatabase?:any,overrides?:any)=>any} */
        const runtimeFor = (
          /** @type {any} */ targetDatabase = database,
          /** @type {any} */ overrides = {},
        ) =>
          createOlistApiRuntime(targetDatabase, {
            environment,
            access: {
              authorizeRead: async (/** @type {any} */ input) =>
                authenticate(input, false),
              authorizeWrite: async (/** @type {any} */ input) =>
                authenticate(input, true),
            },
            fetch: fetcher,
            clock: () => current,
            ...overrides,
          });
        const runtime = runtimeFor();
        fixtureActorId = actors.admin.actor.id;
        return {
          actors,
          runtime,
          runtimeFor,
          calls,
          fetcher,
          responses,
          behavior,
          sale,
          orderId,
          contactId,
          ficha,
          setClock: (/** @type {Date} */ value) => {
            current = value;
          },
          input: { ...actors.admin, orderId },
        };
      }

      async function counts() {
        return (
          await pool.query(
            `SELECT
          (SELECT count(*)::integer FROM crm.olist_exports) exports,
          (SELECT count(*)::integer FROM crm.olist_read_requests) reads,
          (SELECT count(*)::integer FROM crm.outbox_jobs WHERE job_type LIKE 'olist.%') jobs,
          (SELECT count(*)::integer FROM crm.olist_events WHERE event_code='OLIST_EXISTING_SALE_LINKED') links,
          (SELECT count(*)::integer FROM crm.idempotency_records WHERE actor_id=$1 AND action='olist.link') linkReceipts,
          (SELECT count(*)::integer FROM crm.idempotency_records WHERE actor_id=$1 AND action='olist.reconcile') readReceipts`,
            [fixtureActorId],
          )
        ).rows[0];
      }
      /** @param {any} f */
      async function command(f, key = 'synthetic-existing-link') {
        const preview = await f.runtime.existingPreview({
          ...f.input,
          saleId: '401',
        });
        assert.equal(preview.eligible, true);
        assert.equal(preview.sale.id, '401');
        assert.equal(typeof preview.previewToken, 'string');
        return {
          ...f.input,
          previewToken: preview.previewToken,
          reason: 'PRIVATE_SYNTHETIC_REASON',
          idempotencyKey: key,
        };
      }
      /** @param {any} f */
      function noWrites(f) {
        assert.ok(
          f.calls.every((/** @type {any} */ call) => call.method === 'GET'),
        );
        assert.ok(
          f.calls.every((/** @type {any} */ call) =>
            call.url.startsWith('https://api.tiny.com.br/public-api/v3/'),
          ),
        );
      }

      async function explicitLegacyFixture() {
        const f = await fixture();
        await pool.query(
          'UPDATE crm.olist_settings SET settings_envelope=$2::jsonb WHERE account_key=$1',
          [
            config.accountKey,
            JSON.stringify(
              seal(
                {
                  ...EMPTY_OLIST_SETTINGS,
                  paymentDuePolicy: 'per_order',
                  paymentDueOn: null,
                },
                config.envelopeKey,
                'settings',
                config.accountKey,
                'central',
              ),
            ),
          ],
        );
        for (const [path, product] of f.responses)
          if (path.startsWith('/produtos/')) {
            product.sku = '';
            product.ncm = '';
            product.unidade = '';
            product.origem = '0';
            if (Array.isArray(product.variacoes)) {
              delete product.tipo;
              product.tipoVariacao = 'P';
              product.descricao = 'Uniforme legado conferido';
              for (const child of product.variacoes) child.sku = '';
            }
          }
        f.sale.ecommerce.id = 0;
        f.sale.listaPreco = { id: 0 };
        f.sale.numeroOrdemCompra = 'SYNTHETIC-PO-41';
        f.sale.pagamento = {
          parcelas: [{ data: '2026-11-04 00:00:00', valor: 6, transacao: {} }],
        };
        const context = (await f.runtime.administration(f.input))
          .legacyLinkContext;
        assert.ok(
          context,
          'The administrator receives the explicit group/line selector',
        );
        const mapping = {
          groups: context.groups.map((/** @type {any} */ group) => ({
            groupId: group.groupId,
            parentProductId: '201',
            lines: group.lines.map((/** @type {any} */ line) => ({
              lineId: line.lineId,
              childProductId: '202',
              itemIndex: 0,
            })),
          })),
        };
        return { ...f, mapping };
      }
      async function legacyCounts() {
        return (
          await pool.query(`SELECT
          (SELECT count(*)::int FROM crm.olist_exports) exports,
          (SELECT count(*)::int FROM crm.olist_resources) resources,
          (SELECT count(*)::int FROM crm.olist_export_resources) bindings,
          (SELECT count(*)::int FROM crm.olist_attempts) attempts,
          (SELECT count(*)::int FROM crm.outbox_jobs WHERE job_type LIKE 'olist.%') jobs,
          (SELECT count(*)::int FROM crm.olist_events WHERE event_code='OLIST_LEGACY_SALE_LINKED') links`)
        ).rows[0];
      }
      await t.test(
        'canonical existing link freezes explicit fiscal only when central policy is absent and fences later changes',
        async () => {
          for (const mode of ['link', 'central-change']) {
            const f = await fixture(),
              productFiscal = { ncm: '61091000', origin: 0, unit: 'UN' };
            await pool.query(
              'UPDATE crm.olist_settings SET settings_envelope=$2::jsonb WHERE account_key=$1',
              [
                config.accountKey,
                JSON.stringify(
                  seal(
                    { ...settings, productFiscal: null },
                    config.envelopeKey,
                    'settings',
                    config.accountKey,
                    'central',
                  ),
                ),
              ],
            );
            assert.equal(
              (await f.runtime.administration(f.input)).productFiscalRequired,
              false,
            );
            assert.equal(
              (await f.runtime.administration(f.input)).productFiscalDeferred,
              true,
            );
            const deferred = await f.runtime.existingPreview({
              ...f.input,
              saleId: '401',
            });
            assert.equal(deferred.productFiscal, null);
            assert.equal(deferred.productFiscalDeferred, true);
            const preview = await f.runtime.existingPreview({
              ...f.input,
              saleId: '401',
              productFiscal,
            });
            assert.deepEqual(preview.productFiscal, productFiscal);
            assert.equal(preview.productFiscalRequired, false);
            const command = {
              ...f.input,
              previewToken: preview.previewToken,
              reason: 'Synthetic reviewed fiscal',
              idempotencyKey: 'canonical-selected-fiscal',
            };
            await assert.rejects(
              f.runtime.linkExisting({
                ...command,
                productFiscal: { ...productFiscal, ncm: '99999999' },
              }),
              { code: 'INVALID_REQUEST' },
            );
            if (mode === 'central-change') {
              await pool.query(
                'UPDATE crm.olist_settings SET version=version+1,settings_envelope=$2::jsonb WHERE account_key=$1',
                [
                  config.accountKey,
                  JSON.stringify(
                    seal(
                      {
                        ...settings,
                        productFiscal: { ...productFiscal, ncm: '99999999' },
                      },
                      config.envelopeKey,
                      'settings',
                      config.accountKey,
                      'central',
                    ),
                  ),
                ],
              );
              await assert.rejects(f.runtime.linkExisting(command), {
                code: 'OLIST_PREVIEW_STALE',
              });
              assert.equal((await legacyCounts()).exports, 0);
            } else {
              const linked = await f.runtime.linkExisting(command);
              assert.deepEqual(await f.runtime.linkExisting(command), linked);
              const row = (
                await pool.query(
                  'SELECT snapshot_envelope FROM crm.olist_exports WHERE id=$1',
                  [linked.operationId],
                )
              ).rows[0];
              const snapshot = open(
                row.snapshot_envelope,
                config.envelopeKey,
                'export-snapshot',
                config.accountKey,
                linked.operationId,
              );
              assert.deepEqual(snapshot.productFiscal, productFiscal);
              assert.equal(snapshot.settings.productFiscal, null);
              const central = (
                await pool.query(
                  'SELECT settings_envelope FROM crm.olist_settings WHERE account_key=$1',
                  [config.accountKey],
                )
              ).rows[0];
              assert.equal(
                open(
                  central.settings_envelope,
                  config.envelopeKey,
                  'settings',
                  config.accountKey,
                  'central',
                ).productFiscal,
                null,
              );
              await assert.rejects(
                f.runtime.linkExisting({ ...command, productFiscal }),
                { code: 'INVALID_REQUEST' },
              );
            }
            noWrites(f);
          }
        },
      );
      await t.test(
        'existing ERP buyer supports canonical and T16 links without copying CRM registration or binding customer resources',
        async () => {
          for (const legacy of [false, true]) {
            const f = legacy ? await explicitLegacyFixture() : await fixture();
            await pool.query(
              'UPDATE crm.contacts SET registration_envelope=NULL,version=version+1 WHERE id=$1',
              [f.contactId],
            );
            f.responses.set('/contatos', {
              itens: [{ id: 101 }],
              paginacao: { offset: 0, total: 1, limit: 50 },
            });
            const registrationBefore = (
              await pool.query(
                'SELECT registration_envelope FROM crm.contacts WHERE id=$1',
                [f.contactId],
              )
            ).rows[0];
            const before = await legacyCounts();
            const checked = legacy
              ? await f.runtime.legacyExistingPreview({
                  ...f.input,
                  saleId: '401',
                  mapping: /** @type {any} */ (f).mapping,
                })
              : await f.runtime.existingPreview({ ...f.input, saleId: '401' });
            assert.equal(checked.buyerSourceHint, 'erp-existing-v1');
            const command = {
              ...f.input,
              previewToken: checked.previewToken,
              confirmed: true,
              reason: 'Synthetic reviewed existing ERP buyer',
              idempotencyKey: 'existing-buyer-' + legacy,
            };
            const linked = legacy
              ? await f.runtime.linkLegacyExisting(command)
              : await f.runtime.linkExisting(command);
            const replay = legacy
              ? await f.runtime.linkLegacyExisting(command)
              : await f.runtime.linkExisting(command);
            assert.deepEqual(replay, linked);
            const row = (
              await pool.query('SELECT * FROM crm.olist_exports WHERE id=$1', [
                linked.operationId,
              ])
            ).rows[0];
            const frozen = open(
              row.snapshot_envelope,
              config.envelopeKey,
              'export-snapshot',
              config.accountKey,
              row.id,
            );
            assert.equal(frozen.buyerSource.mode, 'erp-existing-v1');
            assert.equal(frozen.buyerSource.remoteId, '101');
            assert.deepEqual(frozen.customer, {
              nome: 'comprador sintético',
              celular: '5511999990000',
            });
            assert.ok(
              !JSON.stringify(frozen.customer).includes(registration.document),
            );
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT registration_envelope FROM crm.contacts WHERE id=$1',
                  [f.contactId],
                )
              ).rows[0],
              registrationBefore,
            );
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int n FROM crm.olist_export_resources e JOIN crm.olist_resources r ON r.id=e.resource_id WHERE e.export_id=$1 AND r.kind='customer'",
                  [row.id],
                )
              ).rows[0].n,
              0,
            );
            if (legacy)
              assert.deepEqual(await legacyCounts(), {
                ...before,
                exports: before.exports + 1,
                links: before.links + 1,
              });
            noWrites(f);
          }
        },
      );
      await t.test(
        'T16 phone mismatch is human-reviewed only for the selected historical sale and re-read on commit, replay and reconciliation',
        async () => {
          const f = await explicitLegacyFixture();
          await pool.query(
            'UPDATE crm.contacts SET registration_envelope=NULL,version=version+1 WHERE id=$1',
            [f.contactId],
          );
          f.responses.get('/contatos/101').celular = '5511999990001';
          const before = await legacyCounts(),
            crmBefore = (
              await pool.query(
                'SELECT version,contact_details_envelope,registration_envelope FROM crm.contacts WHERE id=$1',
                [f.contactId],
              )
            ).rows[0];
          const preview = await f.runtime.legacyExistingPreview({
            ...f.input,
            saleId: '401',
            mapping: f.mapping,
          });
          assert.deepEqual(preview.buyerReview, {
            mode: 'legacy-sale-buyer-review-v1',
            phoneMismatch: true,
            reusable: false,
            code: 'OLIST_LEGACY_BUYER_PHONE_MISMATCH',
          });
          assert.ok(!JSON.stringify(preview).includes('5511999990001'));
          const command = {
            ...f.input,
            previewToken: preview.previewToken,
            confirmed: true,
            reason:
              'Synthetic explicit historical-only phone divergence reviewed',
            idempotencyKey: 'phone-review',
          };
          await assert.rejects(
            f.runtime.linkLegacyExisting({ ...command, confirmed: false }),
            { code: 'INVALID_REQUEST' },
          );
          assert.deepEqual(await legacyCounts(), before);
          const linked = await f.runtime.linkLegacyExisting(command),
            after = await legacyCounts();
          assert.deepEqual(after, {
            ...before,
            exports: before.exports + 1,
            links: before.links + 1,
          });
          const row = (
            await pool.query('SELECT * FROM crm.olist_exports WHERE id=$1', [
              linked.operationId,
            ])
          ).rows[0];
          const frozen = open(
            row.snapshot_envelope,
            config.envelopeKey,
            'export-snapshot',
            config.accountKey,
            row.id,
          );
          assert.equal(frozen.buyerSource, undefined);
          assert.equal(frozen.legacyBuyerProof.customerId, '101');
          assert.equal(frozen.legacyBuyerProof.saleId, '401');
          assert.ok(
            !JSON.stringify(frozen.legacyBuyerProof).includes('5511999990001'),
          );
          const reads = f.calls.length;
          assert.deepEqual(await f.runtime.linkLegacyExisting(command), linked);
          assert.ok(
            f.calls.length > reads,
            'Historical divergence replay obtains current ERP evidence',
          );
          f.responses.get('/contatos/101').celular = '5511999990002';
          await assert.rejects(f.runtime.linkLegacyExisting(command), {
            code: 'OLIST_CUSTOMER_DIVERGENT',
          });
          assert.deepEqual(await legacyCounts(), after);
          f.responses.get('/contatos/101').celular = '5511999990001';
          const request = await f.runtime.reconcile({
            ...f.input,
            stage: 'sale',
            resourceId: null,
            expectedVersion: Number(row.version),
            reason: 'Synthetic read-only historical buyer review',
            idempotencyKey: 'phone-review-read',
          });
          const dispatcher = createOlistReconciliationRuntime({
            database,
            environment,
            fetch: f.fetcher,
            clock: () => NOW,
          });
          const checked = await createOlistReconciliationHandler({
            dispatcher,
          })(
            {
              jobType: 'olist.reconcile',
              queue: 'olist_reconcile',
              idempotencyKey: request.id,
              olistExportId: row.id,
            },
            { heartbeat: async () => true },
          );
          assert.equal(checked.outcome, 'sent', JSON.stringify(checked));
          assert.deepEqual(
            (
              await pool.query(
                'SELECT version,contact_details_envelope,registration_envelope FROM crm.contacts WHERE id=$1',
                [f.contactId],
              )
            ).rows[0],
            crmBefore,
          );
          noWrites(f);
        },
      );
      await t.test(
        'OLIST-T16: explicit legacy link is isolated, audited, replayable and never adopts canonical resources',
        async () => {
          const f = await explicitLegacyFixture(),
            before = await legacyCounts();
          const resourcesBefore = (
            await pool.query(
              'SELECT * FROM crm.olist_resources WHERE account_key=$1 ORDER BY id',
              [config.accountKey],
            )
          ).rows;
          const orderBefore = (
            await pool.query(
              'SELECT status,version,final_amount_cents,ficha_envelope FROM crm.orders WHERE id=$1',
              [f.orderId],
            )
          ).rows[0];
          const preview = await f.runtime.legacyExistingPreview({
            ...f.input,
            saleId: '401',
            mapping: f.mapping,
          });
          assert.equal(preview.mode, 'legacy-sale-only-v1');
          assert.equal(preview.eligible, true);
          assert.deepEqual(await legacyCounts(), before);
          const input = {
            ...f.input,
            previewToken: preview.previewToken,
            confirmed: true,
            reason: 'PRIVATE_LEGACY_HUMAN_REASON',
            idempotencyKey: 'legacy-commit',
          };
          await assert.rejects(
            f.runtime.linkLegacyExisting({ ...input, confirmed: false }),
            { code: 'INVALID_REQUEST' },
          );
          await assert.rejects(f.runtime.linkExisting(input), {
            code: 'OLIST_PREVIEW_INVALID',
          });
          await assert.rejects(
            f.runtime.existingPreview({ ...f.input, saleId: '401' }),
            { code: 'OLIST_ORDER_INCOMPLETE' },
          );
          const linked = await f.runtime.linkLegacyExisting(input),
            after = await legacyCounts();
          assert.equal(linked.mode, 'legacy-sale-only-v1');
          assert.equal(linked.state, 'linked');
          assert.deepEqual(after, {
            ...before,
            exports: before.exports + 1,
            links: before.links + 1,
          });
          assert.deepEqual(
            (
              await pool.query(
                'SELECT * FROM crm.olist_resources WHERE account_key=$1 ORDER BY id',
                [config.accountKey],
              )
            ).rows,
            resourcesBefore,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT status,version,final_amount_cents,ficha_envelope FROM crm.orders WHERE id=$1',
                [f.orderId],
              )
            ).rows[0],
            orderBefore,
          );
          const calls = f.calls.length;
          assert.deepEqual(await f.runtime.linkLegacyExisting(input), linked);
          assert.equal(
            f.calls.length,
            calls,
            'Replay does not repeat ERP reads or a mutation',
          );
          assert.deepEqual(await legacyCounts(), after);
          const row = (
            await pool.query('SELECT * FROM crm.olist_exports WHERE id=$1', [
              linked.operationId,
            ])
          ).rows[0];
          const mapping = open(
            row.resource_mapping_envelope,
            config.envelopeKey,
            'sale-resources',
            config.accountKey,
            row.id,
          );
          const evidence = open(
            row.readback_envelope,
            config.envelopeKey,
            'sale-readback',
            config.accountKey,
            row.id,
          );
          assert.equal(mapping.mode, 'legacy-sale-only-v1');
          assert.equal(evidence.humanConfirmed, true);
          assert.equal(evidence.reason, input.reason);
          assert.ok(
            !(
              await pool.query(
                'SELECT reason FROM crm.audit_events WHERE target_id=$1',
                [row.id],
              )
            ).rows.some((entry) => entry.reason === input.reason),
          );
          await assert.rejects(
            f.runtime.legacyExistingPreview({
              ...f.input,
              saleId: '401',
              mapping: f.mapping,
            }),
            { code: 'OLIST_RECONCILIATION_REQUIRED' },
          );
          // The only subsequent job is an explicitly requested read-only check;
          // legacy resource selectors cannot confer reusable canonical identities.
          const request = await f.runtime.reconcile({
            ...f.input,
            stage: 'sale',
            resourceId: null,
            expectedVersion: Number(row.version),
            reason: 'Synthetic later verification',
            idempotencyKey: 'legacy-read',
          });
          const dispatcher = createOlistReconciliationRuntime({
            database,
            environment,
            fetch: f.fetcher,
            clock: () => NOW,
          });
          const checked = await createOlistReconciliationHandler({
            dispatcher,
          })(
            {
              jobType: 'olist.reconcile',
              queue: 'olist_reconcile',
              idempotencyKey: request.id,
              olistExportId: row.id,
            },
            { heartbeat: async () => true },
          );
          assert.equal(checked.outcome, 'sent', JSON.stringify(checked));
          noWrites(f);
        },
      );
      await t.test(
        'OLIST-T16: stale ERP/source evidence, session loss and changed correspondence cannot commit',
        async () => {
          for (const mode of ['remote', 'source', 'session', 'mapping']) {
            const f = await explicitLegacyFixture(),
              before = await legacyCounts();
            const preview = await f.runtime.legacyExistingPreview({
              ...f.input,
              saleId: '401',
              mapping: f.mapping,
            });
            if (mode === 'remote')
              f.responses.get('/produtos/201').descricao =
                'Changed after review';
            if (mode === 'source')
              await pool.query(
                'UPDATE crm.orders SET version=version+1 WHERE id=$1',
                [f.orderId],
              );
            if (mode === 'session')
              await pool.query(
                'UPDATE crm.sessions SET revoked_at=$2 WHERE token_hash=$1',
                [f.input.sessionBinding, NOW],
              );
            const input = {
              ...f.input,
              previewToken: preview.previewToken,
              confirmed: true,
              reason: 'Synthetic attestation',
              idempotencyKey: 'legacy-stale',
            };
            if (mode === 'mapping')
              input.previewToken = input.previewToken.slice(0, -4) + 'AAAA';
            await assert.rejects(f.runtime.linkLegacyExisting(input), {
              code:
                mode === 'session'
                  ? 'FORBIDDEN'
                  : mode === 'mapping'
                    ? 'OLIST_PREVIEW_INVALID'
                    : 'OLIST_PREVIEW_STALE',
            });
            assert.deepEqual(await legacyCounts(), before);
            noWrites(f);
          }
        },
      );
      await t.test(
        'OLIST-T16: concurrent legacy commands link the remote sale once and cannot replace a canonical operation',
        async () => {
          const f = await explicitLegacyFixture(),
            before = await legacyCounts();
          const previews = await Promise.all(
            [1, 2].map(() =>
              f.runtime.legacyExistingPreview({
                ...f.input,
                saleId: '401',
                mapping: f.mapping,
              }),
            ),
          );
          const results = await Promise.allSettled(
            previews.map((preview, index) =>
              f.runtime.linkLegacyExisting({
                ...f.input,
                previewToken: preview.previewToken,
                confirmed: true,
                reason: 'Synthetic concurrent review',
                idempotencyKey: 'legacy-race-' + index,
              }),
            ),
          );
          assert.equal(
            results.filter((entry) => entry.status === 'fulfilled').length,
            1,
          );
          assert.deepEqual(await legacyCounts(), {
            ...before,
            exports: before.exports + 1,
            links: before.links + 1,
          });
          noWrites(f);
          const canonical = await fixture();
          await canonical.runtime.linkExisting(await command(canonical));
          const countsBefore = await legacyCounts();
          await assert.rejects(
            canonical.runtime.legacyExistingPreview({
              ...canonical.input,
              saleId: '401',
              mapping: f.mapping,
            }),
            { code: 'OLIST_RECONCILIATION_REQUIRED' },
          );
          assert.deepEqual(await legacyCounts(), countsBefore);
        },
      );

      await t.test(
        'LIVENESS API reads wait briefly for a busy shared quota window instead of failing the request (administration)',
        async () => {
          const f = await fixture();
          await pool.query(
            "INSERT INTO crm.olist_quotas(account_key,blocked_until) VALUES($1,now()+interval '1300 milliseconds') ON CONFLICT (account_key) DO UPDATE SET blocked_until=EXCLUDED.blocked_until",
            [config.accountKey],
          );
          const started = Date.now();
          const result = await f.runtime.existingPreview({
            ...f.input,
            saleId: '401',
          });
          assert.equal(result.eligible, true);
          assert.ok(
            Date.now() - started >= 900,
            'the request waited for quota',
          );
          assert.ok(Date.now() - started < 8000);
        },
      );

      await t.test(
        'admin without checkbox links a legacy sale without reference/line marker and preserves the CRM order',
        async () => {
          const f = await fixture();
          const before = (
            await pool.query('SELECT * FROM crm.orders WHERE id=$1', [
              f.orderId,
            ])
          ).rows[0];
          const input = await command(f);
          const result = await f.runtime.linkExisting(input);
          assert.equal(result.state, 'linked');
          assert.equal(result.number, '9001');
          assert.equal(result.creationEnabled, false);
          const parentIdentity = (
            await pool.query(
              "SELECT id,verified_remote_sku FROM crm.olist_resources WHERE account_key=$1 AND kind='product' AND remote_id='201'",
              [config.accountKey],
            )
          ).rows[0];
          assert.equal(
            parentIdentity.verified_remote_sku,
            'SYNTHETIC-LEGACY-P',
          );
          await assert.rejects(
            pool.query(
              'UPDATE crm.olist_resources SET verified_remote_sku=$2 WHERE id=$1',
              [parentIdentity.id, 'CHANGED-SKU'],
            ),
            /immutable/u,
          );
          await assert.rejects(
            pool.query(
              "UPDATE crm.olist_resources SET remote_id='999999' WHERE id=$1",
              [parentIdentity.id],
            ),
            /immutable/u,
          );

          assert.deepEqual(
            (
              await pool.query('SELECT * FROM crm.orders WHERE id=$1', [
                f.orderId,
              ])
            ).rows[0],
            before,
          );
          assert.deepEqual(await counts(), {
            exports: 1,
            reads: 0,
            jobs: 0,
            links: 1,
            linkreceipts: 1,
            readreceipts: 0,
          });
          const row = (
            await pool.query('SELECT * FROM crm.olist_exports WHERE id=$1', [
              result.operationId,
            ])
          ).rows[0];
          const evidence = open(
            row.readback_envelope,
            config.envelopeKey,
            'sale-readback',
            config.accountKey,
            row.id,
          );
          assert.equal(evidence.reason, 'PRIVATE_SYNTHETIC_REASON');
          assert.equal(evidence.totalCents, 600);
          const audits = (
            await pool.query(
              'SELECT reason FROM crm.audit_events WHERE actor_id=$1',
              [f.input.actor.id],
            )
          ).rows;
          assert.doesNotMatch(
            JSON.stringify(audits),
            /PRIVATE_|52998224725|buyer@example/u,
          );
          assert.equal(f.sale.ecommerce.numeroPedidoEcommerce, undefined);
          assert.equal(f.sale.itens[0].infoAdicional, undefined);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM crm.olist_export_resources WHERE export_id=$1',
                [row.id],
              )
            ).rows[0].n,
            3,
          );
          noWrites(f);
        },
      );

      await t.test(
        'same receipt/key replays after review TTL without a new GET, link or audit, but revoked current session/role deny replay',
        async () => {
          for (const revoke of ['session', 'capability']) {
            const f = await fixture();
            const input = await command(f);
            const result = await f.runtime.linkExisting(input);
            f.setClock(new Date(NOW.getTime() + 20 * 60_000));
            const calls = f.calls.length;
            assert.deepEqual(await f.runtime.linkExisting(input), result);
            assert.equal(f.calls.length, calls);
            if (revoke === 'session')
              await pool.query(
                'UPDATE crm.sessions SET revoked_at=$1 WHERE token_hash=$2',
                [NOW, f.input.sessionBinding],
              );
            else
              await pool.query(
                "DELETE FROM crm.user_capabilities WHERE user_id=$1 AND capability='COMMERCIAL_ADMIN'",
                [f.input.actor.id],
              );
            await assert.rejects(f.runtime.linkExisting(input), {
              code: 'FORBIDDEN',
            });
            assert.equal((await counts()).links, 1);
            assert.equal(f.calls.length, calls);
            noWrites(f);
          }
        },
      );

      await t.test(
        'review receipts cannot cross sessions or survive tampering/expiry',
        async () => {
          for (const invalid of ['other-session', 'tampered', 'expired']) {
            const f = await fixture();
            const input = await command(f);
            if (invalid === 'other-session') {
              const other = hash(randomUUID());
              await pool.query(
                'INSERT INTO crm.sessions(token_hash,user_id,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES($1,$2,$3,$4,$4,$5)',
                [
                  other,
                  f.input.actor.id,
                  hash('synthetic-csrf'),
                  NOW,
                  new Date(NOW.getTime() + 86400000),
                ],
              );
              input.sessionBinding = other;
            } else if (invalid === 'tampered') {
              const at = Math.floor(input.previewToken.length / 2);
              input.previewToken =
                input.previewToken.slice(0, at) +
                (input.previewToken[at] === 'A' ? 'B' : 'A') +
                input.previewToken.slice(at + 1);
            } else f.setClock(new Date(NOW.getTime() + 16 * 60_000));
            await assert.rejects(f.runtime.linkExisting(input), {
              code:
                invalid === 'expired'
                  ? 'OLIST_PREVIEW_EXPIRED'
                  : 'OLIST_PREVIEW_INVALID',
            });
            assert.equal((await counts()).exports, 0);
            assert.equal((await counts()).linkreceipts, 0);
            noWrites(f);
          }
        },
      );

      await t.test(
        'source/settings changes during preview GET invalidate the review without an operation',
        async () => {
          for (const target of ['order', 'settings']) {
            const f = await fixture();
            f.behavior.changeDuringFetch = async () => {
              if (target === 'order')
                await pool.query(
                  'UPDATE crm.orders SET version=version+1 WHERE id=$1',
                  [f.orderId],
                );
              else
                await pool.query(
                  'UPDATE crm.olist_settings SET version=version+1 WHERE account_key=$1',
                  [config.accountKey],
                );
            };
            await assert.rejects(
              f.runtime.existingPreview({ ...f.input, saleId: '401' }),
              { code: 'OLIST_PREVIEW_STALE' },
            );
            assert.equal((await counts()).exports, 0);
            noWrites(f);
          }
        },
      );

      await t.test(
        'remote drift between review and commit is rejected and another Pedido reference never binds',
        async () => {
          for (const drift of ['number', 'line', 'foreign-reference']) {
            const f = await fixture();
            const input = await command(f);
            if (drift === 'number') f.sale.numeroPedido = 9002;
            else if (drift === 'line') f.sale.itens[0].valorUnitario = 2.01;
            else f.sale.ecommerce.numeroPedidoEcommerce = 'CRM-another-order';
            await assert.rejects(f.runtime.linkExisting(input), {
              code:
                drift === 'number'
                  ? 'OLIST_PREVIEW_STALE'
                  : drift === 'line'
                    ? 'OLIST_SALE_READBACK_MISMATCH'
                    : 'OLIST_SALE_REFERENCE_CONFLICT',
            });
            assert.equal((await counts()).exports, 0);
            assert.equal((await counts()).linkreceipts, 0);
            noWrites(f);
          }
        },
      );

      await t.test(
        'two previews and independent keys converge to one remote link under concurrent real runtimes',
        async () => {
          const f = await fixture();
          const first = await command(f, 'independent-link-1');
          const second = await command(f, 'independent-link-2');
          const [a, b] = await Promise.all([
            f.runtime.linkExisting(first),
            f.runtimeFor().linkExisting(second),
          ]);
          assert.equal(a.operationId, b.operationId);
          assert.equal(a.state, 'linked');
          assert.equal(b.state, 'linked');
          assert.equal((await counts()).exports, 1);
          assert.equal((await counts()).links, 1);
          assert.equal((await counts()).linkreceipts, 2);
          noWrites(f);
        },
      );

      await t.test(
        'converging links cannot accept a remote number different from the already linked proof',
        async () => {
          const f = await fixture();
          const first = await command(f, 'number-first');
          f.sale.numeroPedido = 9002;
          const second = await command(f, 'number-second');
          f.sale.numeroPedido = 9001;
          await f.runtime.linkExisting(first);
          f.sale.numeroPedido = 9002;
          await assert.rejects(f.runtime.linkExisting(second), {
            code: 'OLIST_SALE_DIVERGENT',
          });
          const row = (
            await pool.query(
              'SELECT remote_number FROM crm.olist_exports WHERE order_id=$1',
              [f.orderId],
            )
          ).rows[0];
          assert.equal(row.remote_number, '9001');
          assert.equal((await counts()).links, 1);
          noWrites(f);
        },
      );

      await t.test(
        'audit or idempotency completion failure rolls back the complete link and retry can persist the same result',
        async () => {
          for (const pattern of [
            /INSERT INTO crm\.audit_events/u,
            /UPDATE crm\.idempotency_records/u,
          ]) {
            const f = await fixture();
            const input = await command(f);
            const failing = {
              query: database.query,
              transaction: (/** @type {any} */ work) =>
                withTransaction(pool, (tx) =>
                  work({
                    query: async (
                      /** @type {string} */ sql,
                      /** @type {any[]} */ values = [],
                    ) => {
                      if (pattern.test(sql))
                        throw new Error('synthetic atomic failure');
                      return tx.query(sql, values);
                    },
                  }),
                ),
            };
            await assert.rejects(f.runtimeFor(failing).linkExisting(input));
            assert.equal((await counts()).exports, 0);
            assert.equal((await counts()).links, 0);
            assert.equal((await counts()).linkreceipts, 0);
            assert.equal((await f.runtime.linkExisting(input)).state, 'linked');
            noWrites(f);
          }
        },
      );

      await t.test(
        'reconciliation request is idempotent and atomically queues only the dedicated read job with no HTTP',
        async () => {
          const f = await fixture();
          const linked = await f.runtime.linkExisting(await command(f));
          const row = (
            await pool.query(
              'SELECT version FROM crm.olist_exports WHERE id=$1',
              [linked.operationId],
            )
          ).rows[0];
          const before = f.calls.length;
          const input = {
            ...f.input,
            stage: 'sale',
            resourceId: null,
            expectedVersion: Number(row.version),
            reason: 'PRIVATE_READ_REASON',
            idempotencyKey: 'one-read-command',
          };
          const first = await f.runtime.reconcile(input);
          assert.deepEqual(await f.runtime.reconcile(input), first);
          assert.equal(f.calls.length, before);
          assert.equal(first.status, 'queued');
          assert.equal((await counts()).reads, 1);
          assert.equal((await counts()).jobs, 1);
          assert.equal((await counts()).readreceipts, 1);
          const job = (
            await pool.query(
              "SELECT * FROM crm.outbox_jobs WHERE job_type='olist.reconcile'",
            )
          ).rows[0];
          assert.equal(job.queue, 'olist_reconcile');
          assert.equal(job.effect_policy, 'internal');
          assert.equal(job.olist_export_id, linked.operationId);
          assert.equal(job.idempotency_key, first.requestId);
          assert.equal(
            (
              await f.runtime.readReconciliation({
                ...f.input,
                requestId: first.requestId,
              })
            ).status,
            'queued',
          );
          noWrites(f);
        },
      );

      await t.test(
        'queued reads are consumed by the real read-only worker with the persisted administrator and no creation flag',
        async () => {
          const f = await fixture();
          const linked = await f.runtime.linkExisting(await command(f));
          const target = (
            await pool.query(
              "SELECT r.id,r.version FROM crm.olist_resources r JOIN crm.olist_export_resources e ON e.resource_id=r.id WHERE e.export_id=$1 AND r.kind='customer'",
              [linked.operationId],
            )
          ).rows[0];
          const request = await f.runtime.reconcile({
            ...f.input,
            stage: 'customer',
            resourceId: target.id,
            expectedVersion: Number(target.version),
            reason: 'Synthetic verification',
            idempotencyKey: 'real-reader-job',
          });
          const before = f.calls.length;
          const dispatcher = createOlistReconciliationRuntime({
            database,
            environment,
            fetch: f.fetcher,
            clock: () => NOW,
          });
          // The shared window turns busy for ~1.3 s: the read worker waits for
          // it (beating the lease) instead of ending the read as RATE_LIMITED.
          await pool.query(
            "INSERT INTO crm.olist_quotas(account_key,blocked_until) VALUES($1,now()+interval '1300 milliseconds') ON CONFLICT (account_key) DO UPDATE SET blocked_until=EXCLUDED.blocked_until",
            [config.accountKey],
          );
          let beats = 0;
          const waitStart = Date.now();
          const result = await createOlistReconciliationHandler({ dispatcher })(
            {
              jobType: 'olist.reconcile',
              queue: 'olist_reconcile',
              idempotencyKey: request.id,
              olistExportId: linked.operationId,
              actor: { id: 'forged' },
            },
            {
              heartbeat: async () => {
                beats += 1;
                return true;
              },
            },
          );
          assert.equal(result.outcome, 'sent', JSON.stringify(result));
          assert.ok(Date.now() - waitStart >= 900, 'the read waited for quota');
          assert.ok(beats >= 3, 'the lease was beaten while waiting: ' + beats);
          assert.ok(f.calls.length > before);
          const saved = await f.runtime.readReconciliation({
            ...f.input,
            requestId: request.id,
          });
          assert.equal(saved.status, 'succeeded');
          const operation = (
            await pool.query(
              'SELECT version FROM crm.olist_exports WHERE id=$1',
              [linked.operationId],
            )
          ).rows[0];
          const saleRead = await f.runtime.reconcile({
            ...f.input,
            stage: 'sale',
            resourceId: null,
            expectedVersion: Number(operation.version),
            reason: 'Recheck linked legacy sale',
            idempotencyKey: 'real-linked-sale-read',
          });
          const saleResult = await createOlistReconciliationHandler({
            dispatcher,
          })(
            {
              jobType: 'olist.reconcile',
              queue: 'olist_reconcile',
              idempotencyKey: saleRead.id,
              olistExportId: linked.operationId,
            },
            { heartbeat: async () => true },
          );
          assert.equal(saleResult.outcome, 'sent', JSON.stringify(saleResult));
          assert.equal(
            (
              await f.runtime.readReconciliation({
                ...f.input,
                requestId: saleRead.id,
              })
            ).status,
            'succeeded',
          );

          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS n FROM crm.olist_attempts',
              )
            ).rows[0].n,
            0,
          );
          noWrites(f);
        },
      );
      await t.test(
        'real reader persists only a blocked ledger when its lease or administrative grant is lost before HTTP',
        async () => {
          for (const loss of ['lease', 'grant']) {
            const f = await fixture();
            const linked = await f.runtime.linkExisting(await command(f));
            const target = (
              await pool.query(
                "SELECT r.id,r.version FROM crm.olist_resources r JOIN crm.olist_export_resources e ON e.resource_id=r.id WHERE e.export_id=$1 AND r.kind='customer'",
                [linked.operationId],
              )
            ).rows[0];
            const request = await f.runtime.reconcile({
              ...f.input,
              stage: 'customer',
              resourceId: target.id,
              expectedVersion: Number(target.version),
              reason: 'Synthetic verification',
              idempotencyKey: 'lost-read-' + loss,
            });
            if (loss === 'grant')
              await pool.query(
                'DELETE FROM crm.user_capabilities WHERE user_id=$1',
                [f.input.actor.id],
              );
            const before = f.calls.length;
            const dispatcher = createOlistReconciliationRuntime({
              database,
              environment,
              fetch: f.fetcher,
              clock: () => NOW,
            });
            const result = await createOlistReconciliationHandler({
              dispatcher,
            })(
              {
                jobType: 'olist.reconcile',
                queue: 'olist_reconcile',
                idempotencyKey: request.id,
                olistExportId: linked.operationId,
              },
              { heartbeat: async () => loss !== 'lease' },
            );
            assert.equal(result.outcome, 'failed');
            assert.equal(f.calls.length, before);
            const saved = (
              await pool.query(
                'SELECT status,safe_code FROM crm.olist_read_requests WHERE id=$1',
                [request.id],
              )
            ).rows[0];
            assert.equal(saved.status, 'blocked');
            assert.equal(
              saved.safe_code,
              loss === 'lease' ? 'OLIST_JOB_LEASE_LOST' : 'FORBIDDEN',
            );
            noWrites(f);
          }
        },
      );

      await t.test(
        'enqueue audit/completion failure rolls back read request, job and receipt without HTTP',
        async () => {
          for (const pattern of [
            /INSERT INTO crm\.audit_events/u,
            /UPDATE crm\.idempotency_records/u,
          ]) {
            const f = await fixture();
            const linked = await f.runtime.linkExisting(await command(f));
            const row = (
              await pool.query(
                'SELECT version FROM crm.olist_exports WHERE id=$1',
                [linked.operationId],
              )
            ).rows[0];
            const before = f.calls.length;
            const input = {
              ...f.input,
              stage: 'sale',
              resourceId: null,
              expectedVersion: Number(row.version),
              reason: 'Synthetic read',
              idempotencyKey: 'atomic-read-command',
            };
            const failing = {
              query: database.query,
              transaction: (/** @type {any} */ work) =>
                withTransaction(pool, (tx) =>
                  work({
                    query: async (
                      /** @type {string} */ sql,
                      /** @type {any[]} */ values = [],
                    ) => {
                      if (pattern.test(sql))
                        throw new Error('synthetic atomic failure');
                      return tx.query(sql, values);
                    },
                  }),
                ),
            };
            await assert.rejects(f.runtimeFor(failing).reconcile(input));
            assert.equal((await counts()).reads, 0);
            assert.equal((await counts()).jobs, 0);
            assert.equal((await counts()).readreceipts, 0);
            assert.equal(f.calls.length, before);
            noWrites(f);
          }
        },
      );

      await t.test(
        'final transaction revalidates local source/settings and administrative grant after the reviewed GET',
        async () => {
          for (const drift of ['order', 'settings', 'capability', 'session']) {
            const f = await fixture();
            const input = await command(f);
            f.behavior.changeDuringFetch = async () => {
              if (drift === 'order')
                await pool.query(
                  'UPDATE crm.orders SET version=version+1 WHERE id=$1',
                  [f.orderId],
                );
              else if (drift === 'settings')
                await pool.query(
                  'UPDATE crm.olist_settings SET version=version+1 WHERE account_key=$1',
                  [config.accountKey],
                );
              else if (drift === 'capability')
                await pool.query(
                  "DELETE FROM crm.user_capabilities WHERE user_id=$1 AND capability='COMMERCIAL_ADMIN'",
                  [f.input.actor.id],
                );
              else
                await pool.query(
                  'UPDATE crm.sessions SET revoked_at=$1 WHERE token_hash=$2',
                  [NOW, f.input.sessionBinding],
                );
            };
            await assert.rejects(f.runtime.linkExisting(input), {
              code: ['capability', 'session'].includes(drift)
                ? 'FORBIDDEN'
                : 'OLIST_PREVIEW_STALE',
            });
            assert.equal((await counts()).exports, 0);
            assert.equal((await counts()).links, 0);
            assert.equal((await counts()).linkreceipts, 0);
            noWrites(f);
          }
        },
      );

      await t.test(
        'a durable sale reservation arriving after preview defeats both another preview and the old link receipt',
        async () => {
          const f = await fixture();
          const input = await command(f);
          const receipt = open(
            JSON.parse(
              Buffer.from(input.previewToken, 'base64url').toString('utf8'),
            ),
            config.envelopeKey,
            'existing-review',
            config.accountKey,
            identityHash(config.hmacKey, 'existing-review', [
              input.actor.id,
              input.sessionBinding,
              input.orderId,
            ]),
          );
          await pool.query(
            "INSERT INTO crm.olist_exports(id,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,reference,state,stage,snapshot_envelope) VALUES($1,$2,$3,1,$4,1,1,$5,0,$6,'reserved','sale',$7::jsonb)",
            [
              receipt.exportId,
              config.accountKey,
              config.contextKey,
              f.orderId,
              f.input.actor.id,
              receipt.reference,
              JSON.stringify(
                seal(
                  receipt.snapshot,
                  config.envelopeKey,
                  'export-snapshot',
                  config.accountKey,
                  receipt.exportId,
                ),
              ),
            ],
          );
          await pool.query(
            "INSERT INTO crm.olist_attempts(id,account_key,export_id,stage,fence,generation) VALUES($1,$2,$3,'sale',$4,1)",
            [randomUUID(), config.accountKey, receipt.exportId, randomUUID()],
          );
          await assert.rejects(
            f.runtime.existingPreview({ ...f.input, saleId: '401' }),
            { code: 'OLIST_RECONCILIATION_REQUIRED' },
          );
          await assert.rejects(f.runtime.linkExisting(input), {
            code: 'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
          });
          assert.equal((await counts()).exports, 1);
          assert.equal((await counts()).links, 0);
          assert.equal((await counts()).linkreceipts, 0);
          const row = (
            await pool.query(
              'SELECT state FROM crm.olist_exports WHERE id=$1',
              [receipt.exportId],
            )
          ).rows[0];
          assert.equal(row.state, 'reserved');
          assert.equal(
            (
              await pool.query(
                'SELECT outcome FROM crm.olist_attempts WHERE export_id=$1',
                [receipt.exportId],
              )
            ).rows[0].outcome,
            'reserved',
          );
          noWrites(f);
        },
      );

      await t.test(
        'the mounted real command uses the administrative session and returns a minimal queued read response',
        async () => {
          const f = await fixture();
          const linked = await f.runtime.linkExisting(await command(f));
          const row = (
            await pool.query(
              'SELECT version FROM crm.olist_exports WHERE id=$1',
              [linked.operationId],
            )
          ).rows[0];
          const api = createApi(
            {},
            {
              olist: f.runtime,
              logger: /** @type {any} */ ({ info() {}, warn() {}, error() {} }),
            },
          );
          const headers = {
            cookie: 'crm_session=' + f.actors.admin.token,
            origin: environment.APP_ORIGIN,
            'x-csrf-token': 'synthetic-csrf',
            'idempotency-key': 'mounted-administrative-read',
          };
          try {
            const response = await api.inject({
              method: 'POST',
              url: '/api/v1/orders/' + f.orderId + '/olist/reconcile',
              headers,
              payload: {
                stage: 'sale',
                resourceId: null,
                expectedVersion: Number(row.version),
                reason: 'PRIVATE_READ_REASON',
              },
            });
            assert.equal(response.statusCode, 202, response.body);
            assert.equal(response.json().status, 'queued');
            assert.equal(
              response.headers['cache-control'],
              'private, no-store',
            );
            assert.doesNotMatch(
              response.body,
              /PRIVATE_|52998224725|accessToken|token_envelope|snapshot_envelope/u,
            );
          } finally {
            await api.close();
          }
          noWrites(f);
        },
      );

      await t.test(
        'LIVENESS the administrative diagnostic is local: a broken ERP connection still serves Admin (200) and refuses everyone else (403), while HTTP commands keep requiring a healthy connection',
        async () => {
          const f = await fixture();
          const linked = await f.runtime.linkExisting(await command(f));
          const row = (
            await pool.query(
              'SELECT version FROM crm.olist_exports WHERE id=$1',
              [linked.operationId],
            )
          ).rows[0];
          const api = createApi(
            {},
            {
              olist: f.runtime,
              logger: /** @type {any} */ ({ info() {}, warn() {}, error() {} }),
            },
          );
          /** @param {string} role */
          const headers = (role) => ({
            cookie: 'crm_session=' + f.actors[role].token,
            origin: environment.APP_ORIGIN,
            'x-csrf-token': 'synthetic-csrf',
          });
          const url = '/api/v1/orders/' + f.orderId + '/olist/administration';
          const before = f.calls.length;
          try {
            for (const broken of [
              'reconnect_required=true,token_envelope=NULL,expires_at=NULL,generation=9',
            ]) {
              await pool.query('UPDATE crm.olist_connections SET ' + broken);
              const admin = await api.inject({
                method: 'GET',
                url,
                headers: headers('admin'),
              });
              assert.equal(admin.statusCode, 200, broken + ' ' + admin.body);
              const body = admin.json();
              assert.equal(body.operation.id, linked.operationId);
              assert.equal(body.operation.version, Number(row.version));
              assert.ok(Array.isArray(body.resources));
              assert.ok(Array.isArray(body.attempts));
              for (const role of ['owner', 'finance']) {
                const denied = await api.inject({
                  method: 'GET',
                  url,
                  headers: headers(role),
                });
                assert.equal(denied.statusCode, 403, role);
                assert.equal(denied.json().code, 'FORBIDDEN');
              }
              // Everything that would call the ERP is still gated by the
              // connection state.
              const reconcile = await api.inject({
                method: 'POST',
                url: '/api/v1/orders/' + f.orderId + '/olist/reconcile',
                headers: {
                  ...headers('admin'),
                  'idempotency-key': 'broken-' + randomUUID(),
                },
                payload: {
                  stage: 'sale',
                  resourceId: null,
                  expectedVersion: Number(row.version),
                  reason: 'PRIVATE_READ_REASON',
                },
              });
              assert.equal(reconcile.statusCode, 409, reconcile.body);
              assert.equal(reconcile.json().code, 'OLIST_CONNECTION_CHANGED');
            }
            // The local command is not gated by it: it answers on its own
            // merits (a linked sale is not invalidable), never as a
            // connection error.
            const invalidate = await api.inject({
              method: 'POST',
              url: '/api/v1/orders/' + f.orderId + '/olist/invalidate',
              headers: {
                ...headers('admin'),
                'idempotency-key': 'broken-invalidate-' + randomUUID(),
              },
              payload: {
                operationId: linked.operationId,
                expectedVersion: Number(row.version),
                reason: 'PRIVATE_INVALIDATE_REASON',
              },
            });
            assert.equal(invalidate.statusCode, 409, invalidate.body);
            assert.equal(invalidate.json().code, 'OLIST_INVALIDATION_BLOCKED');
          } finally {
            await api.close();
          }
          assert.equal(f.calls.length, before, 'no ERP call at all');
        },
      );
    } finally {
      await pool.end();
    }
  });
