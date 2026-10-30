import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOperationReadRuntime,
  createOperationReadService,
} from '../apps/api/src/operation-runtime.js';
import { handoffSummaryLines } from '../apps/edge-web/src/lib/handoff-summary.js';
import { encryptJson } from '../modules/n8n-integration/src/crypto.js';
import { PostgresHandoffReadRepository } from '../modules/work-management/src/index.js';
import { createHandoffCipher } from '../modules/work-management/src/cipher.js';

const HANDOFF_KEY = Buffer.alloc(32, 45);
const N8N_KEY = Buffer.alloc(32, 46);
const SUMMARY =
  'Motivo: Perguntou o valor. Atenção: Bordado em dry fit pede teste; arte em alta. ' +
  'Faltam: quantidade. Ficha: 5 de 9 (56%). ' +
  'Perguntas do cliente: • Vocês fazem parceria? • Qual o mínimo para revenda? ' +
  'Dica: Possível parceria/revenda; Cliente se apresentou pela empresa Malu. ' +
  'IA: Cliente quer saber o valor. Ficha: não é rótulo aqui.';

/** @param {Record<string, any>|null} row */
function repositoryWith(row) {
  const queries = /** @type {Array<{sql: string, values: unknown[]}>} */ ([]);
  const repository = new PostgresHandoffReadRepository({
    contactEnvelopeKey: Buffer.alloc(32, 42),
    database: {
      async query(/** @type {string} */ sql, /** @type {unknown[]} */ values) {
        queries.push({ sql, values });
        if (sql.includes('count(*)')) return { rows: [{ count: row ? 1 : 0 }] };
        return { rows: row ? [row] : [] };
      },
    },
    handoffEnvelopeKey: HANDOFF_KEY,
    n8nEnvelopeKey: N8N_KEY,
  });
  return { queries, repository };
}

/** @param {Record<string, any>} overrides */
function handoffRow(overrides) {
  return {
    conversation_id: 'conversation-1',
    created_at: new Date('2026-10-29T12:00:00.000Z'),
    deal_id: null,
    id: 'handoff-1',
    reason_code: 'price_before_quote',
    status: 'pending',
    version: 1,
    ...overrides,
  };
}

test('INBOX-HANDOFF-01: reads the n8n summary as the plain text the agent wrote', async () => {
  const { queries, repository } = repositoryWith(
    handoffRow({
      summary_envelope: encryptJson(
        SUMMARY,
        'conversation-1:handoff:summary',
        N8N_KEY,
      ),
    }),
  );
  const handoff = await repository.getOpenForConversation('conversation-1');
  assert.deepEqual(handoff, {
    createdAt: '2026-10-29T12:00:00.000Z',
    id: 'handoff-1',
    reasonCode: 'price_before_quote',
    status: 'pending',
    summary: SUMMARY,
    version: 1,
  });
  assert.deepEqual(queries[0].values, ['conversation-1']);
  assert.match(queries[0].sql, /status IN \('pending', 'accepted'\)/u);
  assert.doesNotMatch(JSON.stringify(handoff), /ciphertext|summary_envelope/u);
});

test('INBOX-HANDOFF-01: reads the summary a person wrote for a Deal handoff', async () => {
  const cipher = createHandoffCipher({ key: HANDOFF_KEY });
  const { repository } = repositoryWith(
    handoffRow({
      deal_id: 'deal-1',
      status: 'accepted',
      summary_envelope: cipher.encrypt(
        '"Cliente" pediu retorno amanhã.',
        'deal-1:conversation-1:handoff:summary',
      ),
    }),
  );
  const handoff = await repository.getOpenForConversation('conversation-1');
  assert.equal(handoff?.status, 'accepted');
  assert.equal(handoff?.summary, '"Cliente" pediu retorno amanhã.');
});

test('INBOX-HANDOFF-01: pending queue reads the n8n summary with its own key', async () => {
  const { repository } = repositoryWith(
    handoffRow({
      automation_epoch: 2,
      contact_id: 'contact-1',
      conversation_version: 3,
      due_at: new Date('2026-10-29T16:00:00.000Z'),
      updated_at: new Date('2026-10-29T12:00:00.000Z'),
      external_identity_lookup_hash: 'synthetic-identity',
      identity_envelope: encryptJson(
        { externalIdentityId: 'synthetic-customer' },
        JSON.stringify(['crm.contact_identities', 1, 'synthetic-identity']),
        Buffer.alloc(32, 42),
      ),
      summary_envelope: encryptJson(
        SUMMARY,
        'conversation-1:handoff:summary',
        N8N_KEY,
      ),
    }),
  );
  const page = await repository.listOpen({ after: null, limit: 20 });
  assert.equal(page.totalCount, 1);
  assert.equal(page.items[0].summary, SUMMARY);
  assert.doesNotMatch(JSON.stringify(page), /ciphertext|summary_envelope/u);
});

test('INBOX-HANDOFF-01: returns null without an open handoff', async () => {
  const { repository } = repositoryWith(null);
  assert.equal(await repository.getOpenForConversation('conversation-1'), null);
});

test('INBOX-HANDOFF-01: runtime reads existing n8n summaries with the integration key', async () => {
  const key = HANDOFF_KEY.toString('base64url');
  const operations = createOperationReadRuntime(
    {
      async transaction(/** @type {(client: any) => Promise<any>} */ work) {
        return work({ query: this.query });
      },
      async query() {
        return {
          rows: [
            handoffRow({
              summary_envelope: encryptJson(
                SUMMARY,
                'conversation-1:handoff:summary',
                N8N_KEY,
              ),
            }),
          ],
        };
      },
    },
    {
      environment: {
        CONTACT_IDENTITY_ENVELOPE_KEY: key,
        CONTACT_IDENTITY_LOOKUP_KEY: key,
        IDEMPOTENCY_ENVELOPE_KEY: key,
        INBOX_MESSAGE_ENVELOPE_KEY: key,
        HANDOFF_ENVELOPE_KEY: key,
        OPERATION_CURSOR_HMAC_KEY: key,
        N8N_INTEGRATION_ENVELOPE_KEY: N8N_KEY.toString('base64url'),
      },
    },
  );
  const result = await operations.getConversationHandoff({
    conversationId: 'conversation-1',
  });
  assert.equal(result.handoff?.summary, SUMMARY);
});

test('INBOX-HANDOFF-01: never tries the human key for a n8n summary', async () => {
  const { repository } = repositoryWith(
    handoffRow({
      summary_envelope: encryptJson(
        SUMMARY,
        'conversation-1:handoff:summary',
        HANDOFF_KEY,
      ),
    }),
  );
  await assert.rejects(
    repository.getOpenForConversation('conversation-1'),
    /Unable to authenticate handoff envelope/u,
  );
});

test('INBOX-HANDOFF-01: a summary bound to another conversation never decrypts', async () => {
  const { repository } = repositoryWith(
    handoffRow({
      summary_envelope: encryptJson(
        SUMMARY,
        'conversation-2:handoff:summary',
        N8N_KEY,
      ),
    }),
  );
  await assert.rejects(
    repository.getOpenForConversation('conversation-1'),
    (/** @type {Error} */ error) => {
      assert.doesNotMatch(error.message, /Motivo|Ficha/u);
      return true;
    },
  );
});

test('INBOX-HANDOFF-01: the read service requires a conversation id', async () => {
  const calls = /** @type {string[]} */ ([]);
  const service = createOperationReadService({
    contactRepository: {},
    cursorKey: Buffer.alloc(32, 77),
    handoffRepository: {
      async getOpenForConversation(/** @type {string} */ id) {
        calls.push(id);
        return null;
      },
    },
    inboxRepository: {},
  });
  assert.deepEqual(
    await service.getConversationHandoff({ conversationId: 'conversation-1' }),
    { handoff: null },
  );
  await assert.rejects(service.getConversationHandoff({}), {
    statusCode: 400,
  });
  assert.deepEqual(calls, ['conversation-1']);
});

test('INBOX-HANDOFF-01: splits the agent summary into the lines the seller reads', () => {
  const lines = handoffSummaryLines(SUMMARY);
  assert.deepEqual(
    lines.map(({ label, tone }) => [label, tone]),
    [
      ['Motivo', ''],
      ['Atenção', 'warning'],
      ['Faltam', ''],
      ['Ficha', ''],
      ['Perguntas do cliente', ''],
      ['Dica', 'info'],
      ['IA', ''],
    ],
  );
  assert.equal(lines[0].text, 'Perguntou o valor.');
  assert.equal(lines[3].text, '5 de 9 (56%).');
  assert.deepEqual(lines[4].items, [
    'Vocês fazem parceria?',
    'Qual o mínimo para revenda?',
  ]);
  assert.equal(
    lines[5].text,
    'Possível parceria/revenda; Cliente se apresentou pela empresa Malu.',
  );
  // The agent's reasoning is free text and comes last: never split.
  assert.equal(
    lines[6].text,
    'Cliente quer saber o valor. Ficha: não é rótulo aqui.',
  );
});

test('INBOX-HANDOFF-01: keeps the sentences without a label and a free summary whole', () => {
  assert.deepEqual(
    handoffSummaryLines(
      'Motivo: Pré-ficha completa. Pré-ficha completa. Nome: não informado.',
    ).map(({ label, text }) => [label, text]),
    [
      ['Motivo', 'Pré-ficha completa.'],
      ['', 'Pré-ficha completa.'],
      ['Nome', 'não informado.'],
    ],
  );
  assert.deepEqual(
    handoffSummaryLines('Cliente pediu retorno: amanhã cedo.').map(
      ({ label, text }) => [label, text],
    ),
    [['', 'Cliente pediu retorno: amanhã cedo.']],
  );
  assert.deepEqual(handoffSummaryLines(''), []);
  assert.deepEqual(handoffSummaryLines(null), []);
});

test('INBOX-HANDOFF-01: reads the VND-L02 summary, with questions right after the reason', () => {
  const lines = handoffSummaryLines(
    'Motivo: Perguntas de parceria, revenda ou empresa para o vendedor responder uma a uma. ' +
      'Perguntas do cliente: • Vocês fazem parceria? • Nome da loja é Malu, quero revender ' +
      'Perguntou o valor. Atenção: Bordado em dry fit pede teste. Ficha: 3 de 9 (33%). ' +
      'Dica: Possível parceria/revenda.',
  );
  assert.deepEqual(
    lines.map(({ label, text, items }) => [label, text, items]),
    [
      [
        'Motivo',
        'Perguntas de parceria, revenda ou empresa para o vendedor responder uma a uma.',
        [],
      ],
      [
        'Perguntas do cliente',
        '',
        ['Vocês fazem parceria?', 'Nome da loja é Malu, quero revender'],
      ],
      ['', 'Perguntou o valor.', []],
      ['Atenção', 'Bordado em dry fit pede teste.', []],
      ['Ficha', '3 de 9 (33%).', []],
      ['Dica', 'Possível parceria/revenda.', []],
    ],
  );
});
