import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
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
  createStoreOrderService,
  PostgresOrderRepository,
  orderSourceView,
  reviewSizePricingSubtotal,
} from '../modules/orders/src/index.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import {
  EMPTY_OLIST_SETTINGS,
  identityHash,
  olistConfiguration,
  seal,
} from '../modules/olist/src/index.js';
import { syntheticArtwork, syntheticItems } from './fixtures/order-items.js';
import { STORE_NOW, storeOrderBody } from './fixtures/store-order.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-06T12:00:00.000Z');
const ORDER_KEY = Buffer.alloc(32, 71);
const CONTACT_KEY = Buffer.alloc(32, 72);
const environment = {
  APP_ORIGIN: 'https://crm.example.test',
  OLIST_ENABLED: 'true',
  OLIST_CLIENT_ID: 'synthetic-preview-app',
  OLIST_CLIENT_SECRET: 'synthetic-preview-secret',
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
    'OLIST-T06 PostgreSQL preview requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-T06: complete read-only preview fences source, identity, permission and expiry', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
      'Only the dedicated synthetic database may be reset',
    );
    const pool = new Pool({ connectionString, max: 8 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const config = olistConfiguration(environment);
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
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
          'INSERT INTO crm.olist_accounts(account_key) VALUES($1)',
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
        /** @type {{url:string,method:string}[]} */
        const calls = [];
        let changed = false;
        const fetcher = /** @type {typeof fetch} */ (
          async (url, init) => {
            calls.push({ url: String(url), method: init?.method ?? 'GET' });
            if (patch.changeDuringFetch && !changed) {
              changed = true;
              await patch.changeDuringFetch();
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
        const runtime = createOlistApiRuntime(database, {
          environment,
          access: {
            authorizeRead: async (/** @type {any} */ input) =>
              authenticate(input, false),
            authorizeWrite: async (/** @type {any} */ input) =>
              authenticate(input, true),
          },
          fetch: fetcher,
          clock: () => current,
        });
        return {
          actors,
          runtime,
          calls,
          responses,
          orderId,
          contactId,
          ficha,
          setClock: (/** @type {Date} */ value) => {
            current = value;
          },
          input: { ...actors.finance, orderId },
        };
      }
      async function counts() {
        const result = [];
        for (const table of [
          'olist_resources',
          'olist_exports',
          'olist_attempts',
          'olist_events',
          'outbox_jobs',
          'idempotency_records',
        ])
          result.push(
            Number(
              (await pool.query('SELECT count(*) AS n FROM crm.' + table))
                .rows[0].n,
            ),
          );
        return result;
      }
      await t.test(
        'complete pending and confirmed orders of another owner are previewed by enabled Financeiro without effects or private notes',
        async () => {
          for (const status of ['pendente', 'confirmado']) {
            const f = await fixture({ status });
            const before = await counts();
            const preview = await f.runtime.preview(f.input);
            assert.equal(
              preview.eligible,
              true,
              JSON.stringify(preview.issues),
            );
            assert.ok(preview.previewToken);
            assert.ok(preview.registrations);
            assert.equal(preview.creationEnabled, false);
            assert.equal(preview.commercial.totalCents, 600);
            assert.equal(
              preview.commercial.groups[0].lines[0].unitLexeme,
              '2.00',
            );
            assert.equal(preview.commercial.orderDate, '2026-11-06');
            assert.equal(preview.registrations.customer.action, 'reuse');
            assert.equal(
              preview.registrations.groups[0].lines[0].action,
              'reuse',
            );
            assert.doesNotMatch(
              JSON.stringify(preview),
              /INTERNAL_SENTINEL|CONVERSATION_SENTINEL|52998224725|buyer@example|Rua de Teste|artwork|observations|serviceData/,
            );
            const raw = Buffer.from(preview.previewToken, 'base64url').toString(
              'utf8',
            );
            assert.doesNotMatch(raw, /Comprador|529982|Rua de Teste/);
            assert.equal(
              (
                await f.runtime.checkPreview({
                  ...f.input,
                  previewToken: preview.previewToken,
                })
              ).valid,
              true,
            );
            assert.deepEqual(await counts(), before);
            assert.ok(f.calls.length > 0);
            assert.ok(f.calls.every((call) => call.method === 'GET'));
            assert.equal(
              (
                await pool.query(
                  'SELECT status,order_date::text AS order_date FROM crm.orders WHERE id=$1',
                  [f.orderId],
                )
              ).rows[0].order_date,
              status === 'confirmado' ? '2026-11-06' : null,
            );
          }
        },
      );
      await t.test(
        'channel phone and legal name remain sufficient when manual contact name and phone are absent',
        async () => {
          const f = await fixture();
          await pool.query(
            'UPDATE crm.contacts SET display_name=NULL,contact_details_envelope=$2::jsonb WHERE id=$1',
            [
              f.contactId,
              JSON.stringify(
                encryptContactDetails(
                  /** @type {any} */ ({
                    phone: null,
                    email: 'buyer@example.test',
                  }),
                  CONTACT_KEY,
                ),
              ),
            ],
          );
          const identityId = randomUUID(),
            lookupHash = hash('synthetic-phone-' + identityId);
          const iv = randomBytes(12),
            cipher = createCipheriv('aes-256-gcm', CONTACT_KEY, iv);
          cipher.setAAD(
            Buffer.from(
              JSON.stringify(['crm.contact_identities', 1, lookupHash]),
            ),
          );
          const ciphertext = Buffer.concat([
            cipher.update(
              JSON.stringify({ externalIdentityId: '5511999990000' }),
              'utf8',
            ),
            cipher.final(),
          ]);
          const envelope = {
            algorithm: 'AES-256-GCM',
            keyVersion: 1,
            version: 1,
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
          };
          await pool.query(
            "INSERT INTO crm.contact_identities(id,current_contact_id,provider,provider_account_id,channel,external_identity_lookup_hash,identity_kind,phone_status,identity_envelope,created_at,updated_at) VALUES($1,$2,'synthetic','synthetic-account','whatsapp',$3,'phone','confirmed',$4::jsonb,$5,$5)",
            [
              identityId,
              f.contactId,
              lookupHash,
              JSON.stringify(envelope),
              NOW,
            ],
          );
          const preview = await f.runtime.preview(f.input);
          assert.equal(preview.eligible, true, JSON.stringify(preview.issues));
          await pool.query('DELETE FROM crm.contact_identities WHERE id=$1', [
            identityId,
          ]);
          await assert.rejects(
            f.runtime.checkPreview({
              ...f.input,
              previewToken: preview.previewToken,
            }),
            { code: 'OLIST_PREVIEW_STALE' },
          );
        },
      );
      await t.test(
        'one fractional unit blocks the complete export before ERP lookup, without changing commercial validity',
        async () => {
          const f = await fixture({ subtotal: 100 });
          const preview = await f.runtime.preview(f.input);
          assert.equal(preview.eligible, false);
          assert.ok(
            preview.issues.some(
              (/** @type {any} */ issue) =>
                issue.code === 'OLIST_FRACTIONAL_CENT_UNIT',
            ),
          );
          assert.equal(preview.previewToken, null);
          assert.deepEqual(preview.commercial.groups, []);
          assert.equal(f.calls.length, 0);
          assert.equal(
            Number(
              (
                await pool.query(
                  'SELECT final_amount_cents FROM crm.orders WHERE id=$1',
                  [f.orderId],
                )
              ).rows[0].final_amount_cents,
            ),
            100,
          );
        },
      );
      await t.test(
        'a missing remote seller becomes a configuration issue before any creation',
        async () => {
          const f = await fixture({ missingSeller: true });
          const preview = await f.runtime.preview(f.input);
          assert.equal(preview.eligible, false);
          assert.ok(
            preview.issues.some(
              (/** @type {any} */ issue) =>
                issue.code === 'OLIST_SETTINGS_REMOTE_MISSING',
            ),
          );
          assert.equal(preview.previewToken, null);
          assert.ok(f.calls.every((call) => call.method === 'GET'));
        },
      );
      await t.test(
        'confirmed legacy missingFields=[] does not prove source completeness',
        async () => {
          const f = await fixture({ status: 'confirmado', legacy: true });
          const preview = await f.runtime.preview(f.input);
          assert.equal(preview.eligible, false);
          assert.ok(
            preview.issues.some(
              (/** @type {any} */ issue) =>
                issue.code === 'LEGACY_PRICE_BREAKDOWN_REQUIRED',
            ),
          );
          assert.equal(f.calls.length, 0);
        },
      );
      await t.test(
        'paid store order without a supplement stays incomplete and preserves checkout and gateway',
        async () => {
          const f = await fixture();
          const repository = new PostgresOrderRepository({
            database,
            envelopeKey: ORDER_KEY,
          });
          const store = createStoreOrderService({
            repository,
            fabCode: 'SYNTHETIC',
            hmacKey: Buffer.alloc(32, 76),
            acceptTest: true,
            clock: () => STORE_NOW,
          });
          const id = randomUUID();
          const body = storeOrderBody((body) => {
            body.pedido_id = id;
            body.numero_loja = 'LJ-' + id.slice(0, 8).toUpperCase();
            body.pagamento.transaction_nsu = 'preview-store-' + id;
          });
          const result = await store.record({
            actor: 'AUTOMATION_EXECUTOR',
            correlationId: 'synthetic-preview-store',
            record: store.parse(body),
          });
          const persisted = async () =>
            (
              await pool.query(
                'SELECT ficha_envelope,final_amount_cents,paid_on,payment_source,payment_confirmed_at,paid_amount_cents,payment_transaction_nsu,payment_invoice_slug,version FROM crm.orders WHERE id=$1',
                [result.order.id],
              )
            ).rows[0];
          const before = await persisted(),
            countBefore = await counts();
          const preview = await f.runtime.preview({
            ...f.input,
            orderId: result.order.id,
          });
          assert.equal(preview.eligible, false);
          assert.ok(
            preview.issues.some(
              (/** @type {any} */ issue) =>
                issue.code === 'STORE_ORDER_COMPLEMENT_REQUIRED',
            ),
          );
          assert.equal(preview.previewToken, null);
          assert.equal(f.calls.length, 0);
          assert.deepEqual(await persisted(), before);
          assert.deepEqual(await counts(), countBefore);
        },
      );
      await t.test(
        'legacy confirmed preview consumes a real complete supplemental revision and rejects an obsolete source',
        async () => {
          const f = await fixture({ status: 'confirmado' });
          const repository = new PostgresOrderRepository({
            database,
            envelopeKey: ORDER_KEY,
          });
          const legacy = structuredClone(f.ficha);
          delete legacy.sizePricing;
          await pool.query(
            'UPDATE crm.orders SET ficha_envelope=$2::jsonb,version=version+1 WHERE id=$1',
            [
              f.orderId,
              JSON.stringify(
                encryptJson(legacy, `order-ficha:${f.orderId}`, ORDER_KEY),
              ),
            ],
          );
          const historical = (
            await pool.query(
              'SELECT ficha_envelope,final_amount_cents,confirmed_at,confirmed_by,order_date,paid_on FROM crm.orders WHERE id=$1',
              [f.orderId],
            )
          ).rows[0];
          const command = (
            /** @type {number} */ expectedVersion,
            /** @type {any} */ value,
          ) => ({
            actor: f.actors.owner.actor,
            orderId: f.orderId,
            expectedVersion,
            value,
            now: NOW,
            correlationId: 'synthetic-legacy-preview',
          });
          const initialized = await repository.savePriceBreakdown(
            command(2, { action: 'initialize' }),
            undefined,
          );
          const completed = await repository.savePriceBreakdown(
            command(3, {
              action: 'set_subtotals',
              lines: initialized.groups.flatMap((/** @type {any} */ group) =>
                group.lines.map((/** @type {any} */ line) => ({
                  groupId: group.id,
                  lineId: line.id,
                  subtotalCents: 600,
                })),
              ),
            }),
            undefined,
          );
          assert.equal(completed.revision, 2);
          const preview = await f.runtime.preview(f.input);
          assert.equal(preview.eligible, true, JSON.stringify(preview.issues));
          assert.equal(preview.versions.source, 2);
          assert.equal(
            preview.commercial.groups[0].groupId,
            completed.groups[0].id,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT ficha_envelope,final_amount_cents,confirmed_at,confirmed_by,order_date,paid_on FROM crm.orders WHERE id=$1',
                [f.orderId],
              )
            ).rows[0],
            historical,
          );
          legacy.items[0].cor += ' REVISADA';
          await pool.query(
            'UPDATE crm.orders SET ficha_envelope=$2::jsonb,version=version+1 WHERE id=$1',
            [
              f.orderId,
              JSON.stringify(
                encryptJson(legacy, `order-ficha:${f.orderId}`, ORDER_KEY),
              ),
            ],
          );
          const stale = await f.runtime.preview(f.input);
          assert.equal(stale.eligible, false);
          assert.ok(
            stale.issues.some(
              (/** @type {any} */ issue) => issue.code === 'ORDER_SOURCE_STALE',
            ),
          );
          await assert.rejects(
            f.runtime.checkPreview({
              ...f.input,
              previewToken: preview.previewToken,
            }),
            { code: 'OLIST_PREVIEW_STALE' },
          );
        },
      );
      await t.test(
        'store preview consumes its real complete supplement without rewriting checkout and rejects a changed source',
        async () => {
          const f = await fixture();
          const repository = new PostgresOrderRepository({
            database,
            envelopeKey: ORDER_KEY,
          });
          const store = createStoreOrderService({
            repository,
            fabCode: 'SYNTHETIC',
            hmacKey: Buffer.alloc(32, 77),
            acceptTest: true,
            clock: () => STORE_NOW,
          });
          const id = randomUUID();
          const body = storeOrderBody((body) => {
            body.pedido_id = id;
            body.numero_loja = 'LJ-' + id.slice(0, 8).toUpperCase();
            body.pagamento.transaction_nsu = 'preview-complete-store-' + id;
          });
          const saved = await store.record({
            actor: 'AUTOMATION_EXECUTOR',
            correlationId: 'synthetic-store-preview',
            record: store.parse(body),
          });
          const frozen = async () =>
            (
              await pool.query(
                "SELECT to_jsonb(orders)-'version'-'updated_at' AS frozen FROM crm.orders WHERE id=$1",
                [saved.order.id],
              )
            ).rows[0].frozen;
          const before = await frozen();
          const command = (
            /** @type {number} */ expectedVersion,
            /** @type {any} */ value,
          ) => ({
            actor: f.actors.admin.actor,
            orderId: saved.order.id,
            expectedVersion,
            value,
            now: NOW,
            correlationId: 'synthetic-store-preview',
          });
          const initialized = await repository.savePriceBreakdown(
            command(1, { action: 'initialize' }),
            undefined,
          );
          const completed = await repository.savePriceBreakdown(
            command(2, {
              action: 'set_store_details',
              deliveryOn: '2026-11-20',
              applications: initialized.groups.map(
                (/** @type {any} */ group) => ({
                  groupId: group.id,
                  application: 'SUBLIMAÇÃO',
                }),
              ),
              registration,
            }),
            undefined,
          );
          assert.deepEqual(completed.issues, []);
          const order = /** @type {any} */ (
            await repository.findById(saved.order.id)
          );
          const sources = await repository.readPriceBreakdowns([order]);
          const source = orderSourceView(order, sources.get(order.id));
          const plan = buildOlistPreviewPlan({
            source,
            buyer: /** @type {any} */ (source.order).buyer,
            settings,
            now: NOW,
          });
          assert.equal(plan.eligible, true, JSON.stringify(plan.issues));
          const group = plan.commercial.groups[0],
            line = group.lines[0];
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
          const sku =
            'CRM-P-' +
            identityHash(config.hmacKey, 'product', [
              config.accountKey,
              identity,
            ]);
          f.responses.set('/produtos', {
            itens: [{ id: 401, codigo: sku }],
            paginacao: { offset: 0, total: 1, limit: 50 },
          });
          f.responses.set('/produtos/401', {
            id: 401,
            tipo: 'V',
            situacao: 'A',
            sku,
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
                id: 402,
                sku: 'STORE-SYNTHETIC',
                grade: [{ chave: 'Tamanho', valor: line.size }],
              },
            ],
          });
          f.responses.set('/produtos/402', {
            id: 402,
            sku: 'STORE-SYNTHETIC',
            tipoVariacao: 'V',
            situacao: 'A',
            produtoPai: { id: 401 },
          });
          const input = { ...f.input, orderId: order.id };
          const preview = await f.runtime.preview(input);
          assert.equal(preview.eligible, true, JSON.stringify(preview.issues));
          assert.equal(preview.versions.source, 2);
          assert.equal(
            preview.commercial.totalCents,
            saved.order.finalAmountCents,
          );
          assert.equal(
            preview.registrations?.groups[0].lines[0].action,
            'reuse',
          );
          assert.deepEqual(await frozen(), before);
          const changed = structuredClone(saved.order.ficha);
          changed.items[0].cor += ' REVISADA';
          await pool.query(
            'UPDATE crm.orders SET ficha_envelope=$2::jsonb,version=version+1 WHERE id=$1',
            [
              order.id,
              JSON.stringify(
                encryptJson(changed, `order-ficha:${order.id}`, ORDER_KEY),
              ),
            ],
          );
          const stale = await f.runtime.preview(input);
          assert.equal(stale.eligible, false);
          assert.ok(
            stale.issues.some(
              (/** @type {any} */ issue) => issue.code === 'ORDER_SOURCE_STALE',
            ),
          );
          await assert.rejects(
            f.runtime.checkPreview({
              ...input,
              previewToken: preview.previewToken,
            }),
            { code: 'OLIST_PREVIEW_STALE' },
          );
          assert.ok(f.calls.every((call) => call.method === 'GET'));
        },
      );
      await t.test(
        'receipt expires at exactly fifteen minutes, rejects tampering and cannot cross order/session boundaries',
        async () => {
          const f = await fixture();
          const preview = await f.runtime.preview(f.input);
          f.setClock(new Date(NOW.getTime() + 899999));
          assert.equal(
            (
              await f.runtime.checkPreview({
                ...f.input,
                previewToken: preview.previewToken,
              })
            ).valid,
            true,
          );
          f.setClock(new Date(NOW.getTime() + 900000));
          await assert.rejects(
            f.runtime.checkPreview({
              ...f.input,
              previewToken: preview.previewToken,
            }),
            { code: 'OLIST_PREVIEW_EXPIRED' },
          );
          f.setClock(NOW);
          assert.ok(preview.previewToken);
          const envelope = JSON.parse(
            Buffer.from(preview.previewToken, 'base64url').toString('utf8'),
          );
          envelope.tag = Buffer.alloc(16).toString('base64url');
          await assert.rejects(
            f.runtime.checkPreview({
              ...f.input,
              previewToken: Buffer.from(JSON.stringify(envelope)).toString(
                'base64url',
              ),
            }),
            { code: 'OLIST_PREVIEW_INVALID' },
          );
          await pool.query(
            'UPDATE crm.users SET olist_enabled=true,olist_authorization_version=1 WHERE id=$1',
            [f.actors.owner.actor.id],
          );
          await assert.rejects(
            f.runtime.checkPreview({
              ...f.actors.owner,
              orderId: f.orderId,
              previewToken: preview.previewToken,
            }),
            { code: 'OLIST_PREVIEW_INVALID' },
          );
          await assert.rejects(
            f.runtime.checkPreview({
              ...f.input,
              orderId: randomUUID(),
              previewToken: preview.previewToken,
            }),
            { code: 'ORDER_NOT_FOUND' },
          );
        },
      );
      await t.test(
        'order, customer, settings, connection and resource revisions invalidate a previously complete receipt',
        async () => {
          for (const [sql, target] of [
            ['UPDATE crm.orders SET version=version+1 WHERE id=$1', 'orderId'],
            [
              'UPDATE crm.contacts SET version=version+1 WHERE id=$1',
              'contactId',
            ],
            [
              'UPDATE crm.olist_settings SET version=version+1 WHERE account_key=$1',
              'account',
            ],
            [
              'UPDATE crm.olist_connections SET generation=generation+1,version=version+1 WHERE context_key=$1',
              'context',
            ],
            [
              'UPDATE crm.olist_resources SET version=version+1 WHERE account_key=$1',
              'account',
            ],
          ]) {
            const f = await fixture();
            const preview = await f.runtime.preview(f.input);
            assert.equal(preview.eligible, true);
            await pool.query(sql, [
              target === 'orderId'
                ? f.orderId
                : target === 'contactId'
                  ? f.contactId
                  : target === 'account'
                    ? config.accountKey
                    : config.contextKey,
            ]);
            await assert.rejects(
              f.runtime.checkPreview({
                ...f.input,
                previewToken: preview.previewToken,
              }),
              { code: 'OLIST_PREVIEW_STALE' },
            );
          }
        },
      );
      await t.test(
        'current checkbox, disabled user and revoked session override supplied actors and valid receipts',
        async () => {
          for (const mutation of ['checkbox', 'disabled', 'session']) {
            const f = await fixture();
            const preview = await f.runtime.preview(f.input);
            if (mutation === 'checkbox')
              await pool.query(
                'UPDATE crm.users SET olist_enabled=false,olist_authorization_version=olist_authorization_version+1 WHERE id=$1',
                [f.actors.finance.actor.id],
              );
            if (mutation === 'disabled')
              await pool.query(
                'UPDATE crm.users SET disabled_at=$2 WHERE id=$1',
                [f.actors.finance.actor.id, NOW],
              );
            if (mutation === 'session')
              await pool.query(
                'UPDATE crm.sessions SET revoked_at=$2 WHERE token_hash=$1',
                [f.input.sessionBinding, NOW],
              );
            await assert.rejects(
              f.runtime.checkPreview({
                ...f.input,
                previewToken: preview.previewToken,
              }),
              { code: 'FORBIDDEN' },
            );
            await assert.rejects(f.runtime.preview(f.input), {
              code: 'FORBIDDEN',
            });
          }
          const f = await fixture();
          await assert.rejects(
            f.runtime.preview({ ...f.actors.admin, orderId: f.orderId }),
            { code: 'FORBIDDEN' },
          );
        },
      );
      await t.test(
        'commercial fallback projection preserves ownership without granting Olist preview',
        async () => {
          const f = await fixture();
          assert.equal(
            (
              await f.runtime.project({
                ...f.actors.owner,
                action: 'order.read',
                orderId: f.orderId,
              })
            ).orderId,
            f.orderId,
          );
          assert.equal(
            (
              await f.runtime.project({
                ...f.actors.admin,
                action: 'order.read',
                orderId: f.orderId,
              })
            ).orderId,
            f.orderId,
          );
          await assert.rejects(
            f.runtime.preview({ ...f.actors.admin, orderId: f.orderId }),
            { code: 'FORBIDDEN' },
          );
          await pool.query(
            'UPDATE crm.orders SET manual_owner_id=$2 WHERE id=$1',
            [f.orderId, f.actors.admin.actor.id],
          );
          await assert.rejects(
            f.runtime.project({
              ...f.actors.owner,
              action: 'order.read',
              orderId: f.orderId,
            }),
            { code: 'FORBIDDEN' },
          );
        },
      );
      await t.test(
        'a settings change during HTTP discovery is fenced before a receipt can be returned',
        async () => {
          const f = await fixture({
            changeDuringFetch: () =>
              pool
                .query(
                  'UPDATE crm.olist_settings SET version=version+1 WHERE account_key=$1',
                  [config.accountKey],
                )
                .then(() => {}),
          });
          const before = await counts();
          await assert.rejects(f.runtime.preview(f.input), {
            code: 'OLIST_PREVIEW_STALE',
          });
          assert.deepEqual(await counts(), before);
        },
      );
      await t.test(
        'mounted preview routes require session, CSRF, enabled checkbox and strict bodies',
        async () => {
          const f = await fixture();
          const api = createApi(
            {},
            {
              olist: f.runtime,
              logger: /** @type {any} */ ({ info() {}, warn() {}, error() {} }),
            },
          );
          const headers = {
            cookie: `crm_session=${f.actors.finance.token}; crm_csrf=synthetic-csrf`,
            origin: environment.APP_ORIGIN,
            'x-csrf-token': 'synthetic-csrf',
          };
          const url = '/api/v1/orders/' + f.orderId + '/olist/preview';
          try {
            const response = await api.inject({
              method: 'POST',
              url,
              headers,
              payload: {},
            });
            assert.equal(response.statusCode, 200, response.body);
            assert.equal(response.json().eligible, true);
            assert.equal(
              response.headers['cache-control'],
              'private, no-store',
            );
            const check = await api.inject({
              method: 'POST',
              url: url + '/check',
              headers,
              payload: { previewToken: response.json().previewToken },
            });
            assert.equal(check.statusCode, 200, check.body);
            for (const [
              badHeaders,
              payload,
              expected,
            ] of /** @type {Array<[Record<string,string>,Record<string,unknown>,number]>} */ ([
              [{ ...headers, 'x-csrf-token': 'wrong' }, {}, 403],
              [{ ...headers, cookie: '' }, {}, 403],
              [headers, { totalCents: 1 }, 400],
              [
                { ...headers, cookie: `crm_session=${f.actors.admin.token}` },
                {},
                403,
              ],
            ])) {
              const rejected = await api.inject({
                method: 'POST',
                url,
                headers: badHeaders,
                payload,
              });
              assert.equal(rejected.statusCode, expected, rejected.body);
            }
          } finally {
            await api.close();
          }
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
