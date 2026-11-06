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
    'OLIST-T07 PostgreSQL export command requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-T07: one atomic idempotent snapshot and job per order/account', async (t) => {
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
          'INSERT INTO crm.olist_accounts(account_key,creation_enabled,recovery_required) VALUES($1,true,false)',
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
        fixtureActorId = actors.finance.actor.id;
        return {
          actors,
          runtime,
          runtimeFor,
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
        return (
          await pool.query(
            `SELECT
          (SELECT count(*)::integer FROM crm.olist_exports) exports,
          (SELECT count(*)::integer FROM crm.outbox_jobs WHERE job_type='olist.export') jobs,
          (SELECT count(*)::integer FROM crm.olist_events WHERE event_code='OLIST_EXPORT_QUEUED') events,
          (SELECT count(*)::integer FROM crm.audit_events WHERE action='olist.export.request' AND actor_id=$1) audits,
          (SELECT count(*)::integer FROM crm.idempotency_records WHERE action LIKE 'olist.export%' AND actor_id=$1) receipts`,
            [fixtureActorId],
          )
        ).rows[0];
      }
      /** @param {any} f */
      async function command(f, key = 'export-command') {
        const preview = await f.runtime.preview(f.input);
        assert.equal(preview.eligible, true, JSON.stringify(preview.issues));
        assert.equal(typeof preview.previewToken, 'string');
        return {
          ...f.input,
          previewToken: preview.previewToken,
          idempotencyKey: key,
        };
      }
      await t.test(
        'enabled Financeiro accepts another owner pending order without ERP HTTP or changing the CRM order',
        async () => {
          const f = await fixture();
          const input = await command(f);
          const before = (
            await pool.query('SELECT * FROM crm.orders WHERE id=$1', [
              f.orderId,
            ])
          ).rows[0];
          const calls = f.calls.length;
          const result = await f.runtime.exportOrder(input);
          assert.deepEqual(Object.keys(result).sort(), [
            'creationEnabled',
            'number',
            'operationId',
            'orderId',
            'stage',
            'state',
          ]);
          assert.equal(result.orderId, f.orderId);
          assert.equal(result.creationEnabled, false);
          assert.equal(result.state, 'queued');
          assert.equal(result.stage, 'customer');
          assert.equal(
            f.calls.length,
            calls,
            'Export command must perform no ERP GET or POST',
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
            jobs: 1,
            events: 1,
            audits: 1,
            receipts: 1,
          });
          const row = (
            await pool.query('SELECT * FROM crm.olist_exports WHERE id=$1', [
              result.operationId,
            ])
          ).rows[0];
          const snapshot = open(
            row.snapshot_envelope,
            config.envelopeKey,
            'export-snapshot',
            config.accountKey,
            row.id,
          );
          assert.equal(snapshot.policy, 'exact-cent-v1');
          assert.equal(snapshot.customer.cpfCnpj, registration.document);
          assert.equal(snapshot.commercial.totalCents, 600);
          assert.equal(snapshot.commercial.orderDate, '2026-11-06');
          assert.equal(snapshot.sourceVersions.contactId, f.contactId);
          assert.equal(snapshot.sourceVersions.contactVersion, 1);
          assert.equal(
            snapshot.commercial.groups[0].lines[0].unitLexeme,
            '2.00',
          );
          assert.doesNotMatch(
            JSON.stringify(snapshot),
            /INTERNAL_SENTINEL|CONVERSATION_SENTINEL|observations|serviceData|artwork|files/u,
          );
          assert.doesNotMatch(
            JSON.stringify(result),
            /52998224725|buyer@example|Rua de Teste|previewToken|ciphertext|secret/u,
          );
          const job = (
            await pool.query(
              "SELECT * FROM crm.outbox_jobs WHERE job_type='olist.export'",
            )
          ).rows[0];
          assert.equal(job.olist_export_id, row.id);
          assert.equal(job.queue, 'olist');
          assert.equal(job.effect_policy, 'queryable');
          assert.doesNotMatch(
            JSON.stringify(row.snapshot_envelope),
            /52998224725|buyer@example|Rua de Teste/u,
          );
        },
      );
      await t.test(
        'confirmed source creates the same isolated command without altering confirmation, payment or delivery',
        async () => {
          const f = await fixture({ status: 'confirmado' });
          const input = await command(f);
          const before = (
            await pool.query(
              'SELECT status,confirmed_at,confirmed_by,paid_on,delivered_on,final_amount_cents,ficha_envelope FROM crm.orders WHERE id=$1',
              [f.orderId],
            )
          ).rows[0];
          const response = await f.runtime.exportOrder(input);
          assert.equal(response.state, 'queued');
          assert.deepEqual(
            (
              await pool.query(
                'SELECT status,confirmed_at,confirmed_by,paid_on,delivered_on,final_amount_cents,ficha_envelope FROM crm.orders WHERE id=$1',
                [f.orderId],
              )
            ).rows[0],
            before,
          );
          assert.deepEqual(await counts(), {
            exports: 1,
            jobs: 1,
            events: 1,
            audits: 1,
            receipts: 1,
          });
        },
      );
      await t.test(
        'same key replays after preview expiry and day change with its original frozen date and no duplicate audit/job',
        async () => {
          const f = await fixture();
          const input = await command(f);
          const first = await f.runtime.exportOrder(input);
          f.setClock(new Date('2026-11-07T12:00:00Z'));
          await pool.query(
            'UPDATE crm.sessions SET last_seen_at=$1,absolute_expires_at=$2 WHERE token_hash=$3',
            [
              new Date('2026-11-07T12:00:00Z'),
              new Date('2026-11-08T12:00:00Z'),
              f.input.sessionBinding,
            ],
          );
          await pool.query('UPDATE crm.olist_connections SET expires_at=$1', [
            new Date('2026-11-08T12:00:00Z'),
          ]);
          assert.deepEqual(await f.runtime.exportOrder(input), first);
          assert.deepEqual(await counts(), {
            exports: 1,
            jobs: 1,
            events: 1,
            audits: 1,
            receipts: 1,
          });
          const row = (await pool.query('SELECT * FROM crm.olist_exports'))
            .rows[0];
          assert.equal(
            open(
              row.snapshot_envelope,
              config.envelopeKey,
              'export-snapshot',
              config.accountKey,
              row.id,
            ).commercial.orderDate,
            '2026-11-06',
          );
        },
      );
      await t.test(
        'two independent preview receipts and keys race through independent runtimes but converge to one snapshot/job',
        async () => {
          const f = await fixture();
          const first = await command(f, 'tab-one');
          const second = await command(f, 'tab-two');
          assert.notEqual(first.previewToken, second.previewToken);
          const runtime = f.runtimeFor();
          const results = await Promise.all([
            f.runtime.exportOrder(first),
            runtime.exportOrder(second),
          ]);
          assert.deepEqual(results[0], results[1]);
          assert.deepEqual(await counts(), {
            exports: 1,
            jobs: 1,
            events: 1,
            audits: 1,
            receipts: 2,
          });
          assert.deepEqual(await f.runtime.exportOrder(first), results[0]);
        },
      );
      await t.test(
        'same idempotency key with a different token or target fails instead of returning another command',
        async () => {
          const f = await fixture();
          const input = await command(f);
          const other = await command(f);
          await f.runtime.exportOrder(input);
          await assert.rejects(
            f.runtime.exportOrder({
              ...input,
              previewToken: other.previewToken,
            }),
            { code: 'IDEMPOTENCY_KEY_REUSED' },
          );
          const otherOrderId = randomUUID();
          await pool.query(
            `WITH n AS(SELECT nextval('crm.order_number_seq') v)
            INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,status,fab_code,ficha_envelope,total_pieces,final_amount_cents,payment_condition,created_by_kind,created_by,created_at,updated_at)
            SELECT $1,v,lpad(v::text,2,'0')||'-CRM',NULL,$2,$3,$4,'pendente','SYNTHETIC',$5::jsonb,3,600,'pix','user',$3,$6,$6 FROM n`,
            [
              otherOrderId,
              f.contactId,
              f.actors.owner.actor.id,
              randomUUID(),
              JSON.stringify(
                encryptJson(f.ficha, `order-ficha:${otherOrderId}`, ORDER_KEY),
              ),
              NOW,
            ],
          );
          await assert.rejects(
            f.runtime.exportOrder({ ...input, orderId: otherOrderId }),
            { code: 'IDEMPOTENCY_KEY_REUSED' },
          );
          assert.deepEqual(await counts(), {
            exports: 1,
            jobs: 1,
            events: 1,
            audits: 1,
            receipts: 1,
          });
        },
      );
      await t.test(
        'stale sources, settings, connection and registration refuse the initial command before any local operation',
        async () => {
          for (const mutate of [
            (/** @type {any} */ f) =>
              pool.query(
                'UPDATE crm.orders SET version=version+1 WHERE id=$1',
                [f.orderId],
              ),
            (/** @type {any} */ f) =>
              pool.query(
                'UPDATE crm.contacts SET version=version+1 WHERE id=$1',
                [f.contactId],
              ),
            () => pool.query('UPDATE crm.olist_settings SET version=version+1'),
            () =>
              pool.query('UPDATE crm.olist_connections SET version=version+1'),
            () =>
              pool.query('UPDATE crm.olist_resources SET version=version+1'),
          ]) {
            const f = await fixture();
            const input = await command(f);
            await mutate(f);
            await assert.rejects(f.runtime.exportOrder(input), {
              code: 'OLIST_PREVIEW_STALE',
            });
            assert.deepEqual(await counts(), {
              exports: 0,
              jobs: 0,
              events: 0,
              audits: 0,
              receipts: 0,
            });
          }
        },
      );
      await t.test(
        'expired or tampered initial receipt, disabled integration or recovery gate never enqueue',
        async () => {
          const mutations = [
            async (/** @type {any} */ f, /** @type {any} */ input) => {
              f.setClock(new Date(NOW.getTime() + 15 * 60000));
              return input;
            },
            async (/** @type {any} */ f, /** @type {any} */ input) => ({
              ...input,
              previewToken: 'a' + input.previewToken.slice(1),
            }),
            async (/** @type {any} */ f, /** @type {any} */ input) => {
              await pool.query(
                'UPDATE crm.olist_accounts SET creation_enabled=false',
              );
              return input;
            },
            async (/** @type {any} */ f, /** @type {any} */ input) => {
              await pool.query(
                'UPDATE crm.olist_accounts SET recovery_required=true',
              );
              return input;
            },
          ];
          for (const mutate of mutations) {
            const f = await fixture();
            const input = await mutate(f, await command(f));
            await assert.rejects(f.runtime.exportOrder(input));
            assert.deepEqual(await counts(), {
              exports: 0,
              jobs: 0,
              events: 0,
              audits: 0,
              receipts: 0,
            });
          }
        },
      );
      await t.test(
        'missing command secrets, disabled integration and invalid idempotency keys are rejected without reserving an operation',
        async () => {
          for (const invalid of ['', ' ', 'x'.repeat(129)]) {
            const f = await fixture();
            const input = await command(f);
            await assert.rejects(
              f.runtime.exportOrder({ ...input, idempotencyKey: invalid }),
              { code: 'INVALID_REQUEST' },
            );
            assert.deepEqual(await counts(), {
              exports: 0,
              jobs: 0,
              events: 0,
              audits: 0,
              receipts: 0,
            });
          }
          for (const env of [
            { ...environment, IDEMPOTENCY_ENVELOPE_KEY: '' },
            { ...environment, OLIST_ENABLED: 'false' },
          ]) {
            const f = await fixture();
            const input = await command(f);
            await assert.rejects(
              f.runtimeFor(database, { environment: env }).exportOrder(input),
            );
            assert.deepEqual(await counts(), {
              exports: 0,
              jobs: 0,
              events: 0,
              audits: 0,
              receipts: 0,
            });
          }
        },
      );
      await t.test(
        'current checkbox, session, disabled user and authorization revision are revalidated before replay',
        async () => {
          const mutations = [
            (/** @type {any} */ f) =>
              pool.query(
                'UPDATE crm.users SET olist_enabled=false,olist_authorization_version=olist_authorization_version+1 WHERE id=$1',
                [f.input.actor.id],
              ),
            (/** @type {any} */ f) =>
              pool.query(
                'UPDATE crm.sessions SET revoked_at=$1 WHERE token_hash=$2',
                [NOW, f.input.sessionBinding],
              ),
            (/** @type {any} */ f) =>
              pool.query('UPDATE crm.users SET disabled_at=$1 WHERE id=$2', [
                NOW,
                f.input.actor.id,
              ]),
            (/** @type {any} */ f) =>
              pool.query(
                'UPDATE crm.users SET olist_authorization_version=olist_authorization_version+1 WHERE id=$1',
                [f.input.actor.id],
              ),
          ];
          for (const mutate of mutations) {
            const f = await fixture();
            const input = await command(f);
            await f.runtime.exportOrder(input);
            await mutate(f);
            await assert.rejects(f.runtime.exportOrder(input), {
              code: 'FORBIDDEN',
            });
            assert.deepEqual(await counts(), {
              exports: 1,
              jobs: 1,
              events: 1,
              audits: 1,
              receipts: 1,
            });
          }
        },
      );
      await t.test(
        'idempotency completion, audit and outbox failures roll back snapshot, queue, event and receipt together',
        async () => {
          for (const pattern of [
            /UPDATE crm\.idempotency_records/u,
            /INSERT INTO crm\.audit_events/u,
            /INSERT INTO crm\.outbox_jobs/u,
          ]) {
            const f = await fixture();
            const input = await command(f);
            const failing = {
              query: database.query,
              transaction: (/** @type {any} */ work) =>
                withTransaction(pool, (client) =>
                  work({
                    query: async (
                      /** @type {string} */ sql,
                      /** @type {any[]} */ values = [],
                    ) => {
                      if (pattern.test(sql))
                        throw new Error('synthetic atomic failure');
                      return client.query(sql, values);
                    },
                  }),
                ),
            };
            await assert.rejects(f.runtimeFor(failing).exportOrder(input));
            assert.deepEqual(await counts(), {
              exports: 0,
              jobs: 0,
              events: 0,
              audits: 0,
              receipts: 0,
            });
            await f.runtime.exportOrder(input);
            assert.deepEqual(await counts(), {
              exports: 1,
              jobs: 1,
              events: 1,
              audits: 1,
              receipts: 1,
            });
          }
        },
      );
      await t.test(
        'mounted command is a minimal 202 operation with session/CSRF/idempotency, no browser-supplied commercial authority',
        async () => {
          const f = await fixture();
          const input = await command(f);
          const api = createApi(
            {},
            {
              olist: f.runtime,
              logger: /** @type {any} */ ({ info() {}, warn() {}, error() {} }),
            },
          );
          const headers = {
            cookie: 'crm_session=' + f.actors.finance.token,
            origin: environment.APP_ORIGIN,
            'x-csrf-token': 'synthetic-csrf',
            'idempotency-key': input.idempotencyKey,
          };
          const url = '/api/v1/orders/' + f.orderId + '/olist/export';
          try {
            for (const extra of [
              { amountCents: 1 },
              { settings },
              { accountKey: 'forged' },
              { snapshot: { customer: { cpfCnpj: 'private' } } },
            ]) {
              const response = await api.inject({
                method: 'POST',
                url,
                headers,
                payload: { previewToken: input.previewToken, ...extra },
              });
              assert.equal(response.statusCode, 400);
            }
            for (const patch of [
              { 'x-csrf-token': '' },
              { origin: 'https://other.example.test' },
              { authorization: 'Bearer synthetic-agent' },
            ]) {
              const response = await api.inject({
                method: 'POST',
                url,
                headers: { ...headers, ...patch },
                payload: { previewToken: input.previewToken },
              });
              assert.equal(response.statusCode, 403);
            }
            const missing = await api.inject({
              method: 'POST',
              url,
              headers: { ...headers, 'idempotency-key': '' },
              payload: { previewToken: input.previewToken },
            });
            assert.equal(missing.statusCode, 400);
            const accepted = await api.inject({
              method: 'POST',
              url,
              headers,
              payload: { previewToken: input.previewToken },
            });
            assert.equal(accepted.statusCode, 202, accepted.body);
            assert.equal(accepted.json().creationEnabled, false);
            assert.equal(
              accepted.headers['cache-control'],
              'private, no-store',
            );
            assert.equal(accepted.headers['referrer-policy'], 'no-referrer');
            const admin = await api.inject({
              method: 'POST',
              url,
              headers: {
                ...headers,
                cookie: 'crm_session=' + f.actors.admin.token,
              },
              payload: { previewToken: input.previewToken },
            });
            assert.equal(admin.statusCode, 403);
            assert.deepEqual(await counts(), {
              exports: 1,
              jobs: 1,
              events: 1,
              audits: 1,
              receipts: 1,
            });
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
