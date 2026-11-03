import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { createOrderAssistanceRuntime } from '../apps/api/src/order-assistance-runtime.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  createN8nIntegrationService,
  PostgresN8nIntegrationRepository,
} from '../modules/n8n-integration/src/index.js';
import {
  decryptAssistance,
  encryptAssistance,
} from '../modules/inbox-channels/src/application/order-assistance-envelope.js';

const connectionString = process.env.TEST_DATABASE_URL;
test(
  'OA-T01 PostgreSQL: evidence, ownership, replay, concurrency, stale review and atomic order creation',
  { skip: !connectionString },
  async (t) => {
    assert.match(
      new URL(/** @type {string} */ (connectionString)).pathname.slice(1),
      /^crm_silmer_test(?:_[a-z0-9_]+)?$/u,
      'only a dedicated synthetic test database may be reset',
    );
    const pool = new Pool({ connectionString, max: 8 });
    t.after(async () => {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    });
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    await pool.query(
      `INSERT INTO crm.users (id,email,password_hash,name) VALUES ('oa-seller','oa-seller@example.test','$argon2id$synthetic','Vendedor Sintético'),('oa-other','oa-other@example.test','$argon2id$synthetic','Outro Sintético')`,
    );
    await pool.query(
      `INSERT INTO crm.user_functions (user_id,function_name) VALUES ('oa-seller','Vendedor'),('oa-other','Vendedor')`,
    );
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const key = Buffer.alloc(32, 71),
      contactKey = Buffer.alloc(32, 72),
      lookupKey = Buffer.alloc(32, 73),
      messageKey = Buffer.alloc(32, 74);
    const environment = {
      N8N_INTEGRATION_ENVELOPE_KEY: key.toString('base64'),
      CONTACT_IDENTITY_ENVELOPE_KEY: contactKey.toString('base64'),
      CONTACT_IDENTITY_LOOKUP_KEY: lookupKey.toString('base64'),
      FAB_CODE: 'FAB-TEST',
    };
    const actor = { id: 'oa-seller', kind: 'human', capabilities: [] };
    const runtime = createOrderAssistanceRuntime({
      database,
      environment,
      orders: {
        authorizeRead: async () => ({ actor }),
        authorizeWrite: async () => ({ actor }),
      },
    });
    const inbound = createN8nIntegrationService({
      allowConversationBriefing: true,
      repository: new PostgresN8nIntegrationRepository({
        database,
        envelopeKey: key,
        contactEnvelopeKey: contactKey,
        contactLookupKey: lookupKey,
        messageEnvelopeKey: messageKey,
        requireHumanOrderCreation: true,
      }),
    });
    let sequence = 0;
    /** @param {string} [text] */
    async function seed(text = 'Pode fechar as 20 camisetas brancas.') {
      const index = ++sequence;
      const technical = {
        actor: 'AUTOMATION_EXECUTOR',
        correlationId: 'oa-correlation-' + index,
        credentialVersion: 'current',
        executionId: 'oa-execution-' + index,
        idempotencyKey: 'oa-inbound-' + index,
        requestId: 'oa-request-' + index,
        workflowKey: 'whatsapp-mvp',
        workflowVersion: 'oa-test-1',
      };
      const response = await inbound.receiveInbound({
        schema_version: '1.0',
        channel: 'whatsapp',
        event_id: 'oa-inbound-' + index,
        occurred_at: new Date().toISOString(),
        contact: { wa_id: '551100000' + String(index).padStart(4, '0') },
        metadata: { phone_number_id: 'oa-synthetic' },
        message: { external_id: 'oa-message-' + index, type: 'text', text },
        technical,
      });
      await pool.query(
        `UPDATE crm.conversations SET assigned_user_id='oa-seller',automation_state='human',automation_epoch=automation_epoch+1,version=version+1 WHERE id=$1`,
        [response.conversation_id],
      );
      const conversation = (
        await pool.query('SELECT * FROM crm.conversations WHERE id=$1', [
          response.conversation_id,
        ])
      ).rows[0];
      const message = (
        await pool.query(
          "SELECT id FROM crm.messages WHERE conversation_id=$1 AND direction='inbound'",
          [response.conversation_id],
        )
      ).rows[0];
      const observation = {
        conversation_id: conversation.id,
        source_revision: Number(conversation.inbound_revision),
        automation_epoch: Number(conversation.automation_epoch),
        signal: 'purchase_confirmed',
        product_summary: '20 camisetas brancas',
        evidence_message_id: message.id,
        briefing_patch: {
          product_model: 'camiseta comum',
          colors: 'branca',
          quantity: 20,
        },
        technical,
      };
      const command = {
        actor,
        conversationId: conversation.id,
        idempotencyKey: 'oa-command-' + index,
        correlationId: technical.correlationId,
        decision: 'accept',
        reason: 'ready',
        expectedConversationVersion: Number(conversation.version),
        expectedSourceRevision: Number(conversation.inbound_revision),
        expectedVersion: 1,
      };
      return { conversation, message, observation, command };
    }
    await t.test(
      'production policy preserves initial subject-v1 briefing and blocks legacy opening without technical failure',
      async () => {
        for (const openOrder of [false, true]) {
          const data = await seed('Quero saber o preço de camisetas.');
          await pool.query(
            "UPDATE crm.conversations SET automation_state='assistant' WHERE id=$1",
            [data.conversation.id],
          );
          const eventId = 'oa-initial-' + String(openOrder);
          const result = await inbound.recordEvent({
            schema_version: '1.0',
            event_id: eventId,
            event_type: 'message.send.requested',
            occurred_at: new Date().toISOString(),
            conversation_id: data.conversation.id,
            automation_epoch: Number(data.conversation.automation_epoch),
            source_revision: Number(data.conversation.inbound_revision),
            target_contract: 'subject-v1',
            open_order: openOrder,
            briefing_patch: { product_type: 'camiseta', quantity: 20 },
            command_id: eventId,
            message: { type: 'text', text: 'Qual a cor que você procura?' },
            technical: {
              ...data.observation.technical,
              idempotencyKey: eventId,
            },
          });
          assert.equal(result.send_authorized, true);
          if (openOrder)
            assert.deepEqual(result.order, {
              opened: null,
              status: 'awaiting_human',
            });
          assert.equal(
            (
              await pool.query(
                'SELECT count(*) AS total FROM crm.orders WHERE conversation_id=$1',
                [data.conversation.id],
              )
            ).rows[0].total,
            '0',
          );
          assert.ok(
            Number(
              (
                await pool.query(
                  'SELECT briefing_version FROM crm.conversations WHERE id=$1',
                  [data.conversation.id],
                )
              ).rows[0].briefing_version,
            ) > 0,
          );
        }
      },
    );
    await t.test(
      'a discovery observation cannot create an order, purchase creates one encrypted suggestion and duplicate creates none',
      async () => {
        const data = await seed('Vocês fazem camisetas?');
        await runtime.observe({
          ...data.observation,
          signal: 'uncertain',
          product_summary: null,
          evidence_message_id: null,
        });
        assert.equal(
          (await runtime.list({ actor, conversationId: data.conversation.id }))
            .suggestions.length,
          0,
        );
        assert.equal(
          Number(
            (await pool.query('SELECT count(*) FROM crm.orders')).rows[0].count,
          ),
          0,
        );
        const purchase = await seed();
        await Promise.all([
          runtime.observe(purchase.observation),
          runtime.observe(purchase.observation),
        ]);
        const suggestions = (
          await runtime.list({
            actor,
            conversationId: purchase.conversation.id,
          })
        ).suggestions;
        assert.equal(suggestions.length, 1);
        const row = (
          await pool.query(
            'SELECT details_envelope FROM crm.order_assistance_suggestions WHERE id=$1',
            [suggestions[0].id],
          )
        ).rows[0];
        assert.equal(JSON.stringify(row).includes('camiseta'), false);
        assert.equal(
          Number(
            (await pool.query('SELECT count(*) FROM crm.orders')).rows[0].count,
          ),
          0,
        );
      },
    );
    await t.test(
      'wrong conversation evidence and nonowner command fail without any order',
      async () => {
        const first = await seed(),
          second = await seed();
        await assert.rejects(
          runtime.observe({
            ...first.observation,
            evidence_message_id: second.message.id,
          }),
          { code: 'INVALID_PURCHASE_EVIDENCE' },
        );
        await runtime.observe(first.observation);
        const suggestion = (
          await runtime.list({ actor, conversationId: first.conversation.id })
        ).suggestions[0];
        await assert.rejects(
          runtime.decide({
            ...first.command,
            suggestionId: suggestion.id,
            actor: { ...actor, id: 'oa-other' },
          }),
          { code: 'FORBIDDEN' },
        );
        assert.equal(
          Number(
            (
              await pool.query(
                'SELECT count(*) FROM crm.orders WHERE conversation_id=$1',
                [first.conversation.id],
              )
            ).rows[0].count,
          ),
          0,
        );
      },
    );
    await t.test(
      'same-key concurrent confirmation creates exactly one pending order with pre-ficha, subject link, decision and audit',
      async () => {
        const data = await seed();
        await runtime.observe(data.observation);
        const suggestion = (
          await runtime.list({ actor, conversationId: data.conversation.id })
        ).suggestions[0];
        const command = { ...data.command, suggestionId: suggestion.id };
        const results = await Promise.all([
          runtime.decide(command),
          runtime.decide(command),
        ]);
        assert.deepEqual(results.map((result) => result.duplicate).sort(), [
          false,
          true,
        ]);
        assert.equal(results[0].order.id, results[1].order.id);
        assert.equal(
          Number(
            (
              await pool.query(
                'SELECT count(*) FROM crm.orders WHERE conversation_id=$1',
                [data.conversation.id],
              )
            ).rows[0].count,
          ),
          1,
        );
        const snapshot = (
          await pool.query(
            `SELECT subject.id,briefing.version,briefing.envelope FROM crm.conversation_subjects subject JOIN crm.subject_briefings briefing ON briefing.subject_id=subject.id WHERE subject.order_id=$1`,
            [results[0].order.id],
          )
        ).rows[0];
        assert.equal(
          decryptAssistance(
            snapshot.envelope,
            `n8n-subject-briefing:${snapshot.id}:${snapshot.version}`,
            key,
          ).product_model,
          'camiseta comum',
        );
        assert.equal(
          (
            await pool.query('SELECT status FROM crm.orders WHERE id=$1', [
              results[0].order.id,
            ])
          ).rows[0].status,
          'pendente',
        );
        assert.equal(
          Number(
            (
              await pool.query(
                'SELECT count(*) FROM crm.conversation_subjects WHERE conversation_id=$1 AND order_id=$2',
                [data.conversation.id, results[0].order.id],
              )
            ).rows[0].count,
          ),
          1,
        );
        assert.equal(
          Number(
            (
              await pool.query(
                `SELECT count(*) FROM crm.audit_events WHERE target_id=$1 AND action='order.assistance.accept'`,
                [data.conversation.id],
              )
            ).rows[0].count,
          ),
          1,
        );
        await assert.rejects(runtime.decide({ ...command, reason: 'other' }));
        await assert.rejects(
          runtime.decide({ ...command, idempotencyKey: 'another-command' }),
          { code: 'ASSISTANCE_STALE' },
        );
      },
    );
    await t.test(
      'changed revision and epoch make suggestion obsolete; future or stale analysis cannot refresh it',
      async () => {
        const data = await seed();
        await runtime.observe(data.observation);
        const suggestion = (
          await runtime.list({ actor, conversationId: data.conversation.id })
        ).suggestions[0];
        await pool.query(
          'UPDATE crm.conversations SET automation_epoch=automation_epoch+1 WHERE id=$1',
          [data.conversation.id],
        );
        assert.equal(
          (await runtime.list({ actor, conversationId: data.conversation.id }))
            .suggestions[0].status,
          'obsolete',
        );
        await assert.rejects(
          runtime.decide({ ...data.command, suggestionId: suggestion.id }),
          { code: 'ASSISTANCE_STALE' },
        );
        assert.equal(
          (await runtime.observe({ ...data.observation, source_revision: 99 }))
            .stale,
          true,
        );
        assert.equal(
          Number(
            (
              await pool.query(
                'SELECT count(*) FROM crm.orders WHERE conversation_id=$1',
                [data.conversation.id],
              )
            ).rows[0].count,
          ),
          0,
        );
      },
    );
    await t.test(
      'purchase reaffirmed after another message refreshes the same pending suggestion, while an old click remains stale',
      async () => {
        const data = await seed();
        await runtime.observe(data.observation);
        const original = (
          await runtime.list({ actor, conversationId: data.conversation.id })
        ).suggestions[0];
        await pool.query(
          'UPDATE crm.conversations SET inbound_revision=inbound_revision+1 WHERE id=$1',
          [data.conversation.id],
        );
        assert.equal(
          (await runtime.list({ actor, conversationId: data.conversation.id }))
            .suggestions[0].status,
          'obsolete',
        );
        await runtime.observe({
          ...data.observation,
          source_revision: data.observation.source_revision + 1,
        });
        const refreshed = (
          await runtime.list({ actor, conversationId: data.conversation.id })
        ).suggestions[0];
        assert.equal(refreshed.id, original.id);
        assert.equal(refreshed.status, 'pending');
        assert.ok(refreshed.version > original.version);
        await assert.rejects(
          runtime.decide({ ...data.command, suggestionId: original.id }),
          { code: 'ASSISTANCE_STALE' },
        );
        const result = await runtime.decide({
          ...data.command,
          suggestionId: refreshed.id,
          expectedVersion: refreshed.version,
          expectedSourceRevision: refreshed.sourceRevision,
        });
        assert.ok(result.order.id);
      },
    );
    await t.test(
      'defer and reject are durable without opening an order or alerting again for the same evidence',
      async () => {
        for (const [decision, reason] of [
          ['defer', 'not_ready'],
          ['reject', 'unsupported'],
        ]) {
          const data = await seed();
          await runtime.observe(data.observation);
          const suggestion = (
            await runtime.list({ actor, conversationId: data.conversation.id })
          ).suggestions[0];
          await runtime.decide({
            ...data.command,
            suggestionId: suggestion.id,
            decision,
            reason,
          });
          await runtime.observe(data.observation);
          await pool.query(
            'UPDATE crm.conversations SET inbound_revision=inbound_revision+1 WHERE id=$1',
            [data.conversation.id],
          );
          await runtime.observe({
            ...data.observation,
            source_revision: data.observation.source_revision + 1,
          });
          const state = await runtime.list({
            actor,
            conversationId: data.conversation.id,
          });
          assert.equal(state.suggestions.length, 1);
          assert.notEqual(state.suggestions[0].status, 'pending');
          assert.equal(state.suggestions[0].reason, reason);
          assert.equal(state.evaluations[0].decision, decision);
          assert.equal(
            Number(
              (
                await pool.query(
                  'SELECT count(*) FROM crm.orders WHERE conversation_id=$1',
                  [data.conversation.id],
                )
              ).rows[0].count,
            ),
            0,
          );
        }
      },
    );
    await t.test(
      'multiple subjects require a human-selected general target; the resulting order uses that subject briefing',
      async () => {
        const data = await seed();
        const contact = (
          await pool.query(
            'SELECT current_contact_id FROM crm.contact_identities WHERE id=$1',
            [data.conversation.contact_identity_id],
          )
        ).rows[0].current_contact_id;
        await pool.query(
          `INSERT INTO crm.conversation_subjects (id,conversation_id,contact_id,kind,position,is_current,created_by,created_by_kind,created_at,updated_at) VALUES ('oa-general-old',$1,$2,'geral',1,false,'oa-seller','human',now(),now()),('oa-general-target',$1,$2,'geral',2,false,'oa-seller','human',now(),now())`,
          [data.conversation.id, contact],
        );
        await runtime.observe(data.observation);
        const blocked = await runtime.list({
          actor,
          conversationId: data.conversation.id,
        });
        assert.equal(blocked.blockedReason, 'subject_target_required');
        assert.equal(blocked.suggestions.length, 0);
        await pool.query(
          `UPDATE crm.conversation_subjects SET is_current=true,selected_source='human',selected_by='oa-seller',selected_at=now(),version=version+1 WHERE id='oa-general-target'`,
        );
        const subjectEnvelope = encryptAssistance(
          { product_model: 'camisa polo', colors: 'azul' },
          'n8n-subject-briefing:oa-general-target:1',
          key,
        );
        await pool.query(
          `INSERT INTO crm.subject_briefings (subject_id,version,envelope,updated_at) VALUES ('oa-general-target',1,$1::jsonb,now())`,
          [JSON.stringify(subjectEnvelope)],
        );
        await pool.query(
          'UPDATE crm.conversations SET inbound_revision=inbound_revision+1,briefing_version=1,briefing_envelope=$2::jsonb,briefing_updated_at=now() WHERE id=$1',
          [
            data.conversation.id,
            JSON.stringify(
              encryptAssistance(
                { product_model: 'produto de outro assunto' },
                `n8n-briefing:${data.conversation.id}:1`,
                key,
              ),
            ),
          ],
        );
        await runtime.observe({
          ...data.observation,
          subject_id: 'oa-general-target',
          source_revision: data.observation.source_revision + 1,
          product_summary: '20 polos azuis',
          briefing_patch: { quantity: 20 },
        });
        const suggestion = (
          await runtime.list({ actor, conversationId: data.conversation.id })
        ).suggestions[0];
        const result = await runtime.decide({
          ...data.command,
          suggestionId: suggestion.id,
          expectedSourceRevision: suggestion.sourceRevision,
        });
        const row = (
          await pool.query(
            'SELECT ficha_envelope FROM crm.orders WHERE id=$1',
            [result.order.id],
          )
        ).rows[0];
        const ficha = decryptAssistance(
          row.ficha_envelope,
          `order-ficha:${result.order.id}`,
          key,
        );
        assert.equal(ficha.items[0].tipo, 'camisa polo');
        assert.equal(ficha.items[0].cor, 'azul');
        const snapshot = (
          await pool.query(
            `SELECT version,envelope FROM crm.subject_briefings WHERE subject_id='oa-general-target'`,
          )
        ).rows[0];
        assert.equal(
          decryptAssistance(
            snapshot.envelope,
            `n8n-subject-briefing:oa-general-target:${snapshot.version}`,
            key,
          ).quantity,
          20,
        );
        assert.equal(
          (await runtime.list({ actor, conversationId: data.conversation.id }))
            .blockedReason,
          'pending_order_exists',
        );
      },
    );
    await t.test(
      'a database failure after order insert rolls back order, subject, decision, command and suggestion status together',
      async () => {
        const data = await seed();
        await runtime.observe(data.observation);
        const suggestion = (
          await runtime.list({ actor, conversationId: data.conversation.id })
        ).suggestions[0];
        await pool.query(
          `CREATE FUNCTION crm.oa_fail_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END; $$`,
        );
        await pool.query(
          `CREATE TRIGGER oa_fail_decision BEFORE INSERT ON crm.order_assistance_decisions FOR EACH ROW EXECUTE FUNCTION crm.oa_fail_decision()`,
        );
        try {
          await assert.rejects(
            runtime.decide({ ...data.command, suggestionId: suggestion.id }),
          );
        } finally {
          await pool.query(
            'DROP TRIGGER oa_fail_decision ON crm.order_assistance_decisions',
          );
          await pool.query('DROP FUNCTION crm.oa_fail_decision()');
        }
        assert.equal(
          Number(
            (
              await pool.query(
                'SELECT count(*) FROM crm.orders WHERE conversation_id=$1',
                [data.conversation.id],
              )
            ).rows[0].count,
          ),
          0,
        );
        assert.equal(
          (await runtime.list({ actor, conversationId: data.conversation.id }))
            .suggestions[0].status,
          'pending',
        );
        assert.equal(
          (
            await runtime.decide({
              ...data.command,
              suggestionId: suggestion.id,
            })
          ).duplicate,
          false,
        );
      },
    );
    await t.test(
      'metrics distinguish explicit omissions from recall and enforce administrator access',
      async () => {
        const data = await seed();
        await runtime.observe({
          ...data.observation,
          signal: 'analysis_failed',
          product_summary: null,
          evidence_message_id: null,
        });
        await runtime.decide({
          ...data.command,
          decision: 'missed',
          sourceMessageId: data.message.id,
        });
        const closed = await seed();
        await pool.query(
          `UPDATE crm.conversations SET state='encerrada',terminal_at=now(),closure_outcome='sem_pedido',closed_by='oa-seller' WHERE id=$1`,
          [closed.conversation.id],
        );
        await runtime.decide({
          ...closed.command,
          decision: 'missed',
          sourceMessageId: closed.message.id,
        });
        assert.equal(
          (
            await runtime.list({
              actor,
              conversationId: closed.conversation.id,
            })
          ).evaluations[0].decision,
          'missed',
        );
        await assert.rejects(runtime.metrics({ actor, days: 30 }), {
          code: 'FORBIDDEN',
        });
        const metrics = await runtime.metrics({
          actor: { ...actor, capabilities: ['COMMERCIAL_ADMIN'] },
          days: 30,
        });
        assert.ok(metrics.accepted >= 2);
        assert.equal(metrics.missed, 2);
        assert.equal(metrics.observationFailures, 1);
        assert.ok(metrics.deferred >= 1);
        assert.ok(metrics.rejected >= 1);
      },
    );
  },
);
