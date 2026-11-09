import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canOfferInvalidate,
  canOfferLink,
  countResources,
  deriveOlistProgress,
  isAdminInvalidated,
  isOperationInProgress,
  isOperationUncertain,
  olistOperationHeadline,
  progressAnnouncement,
  reconcileTargets,
  safeAttempts,
  safeCode,
  safeRemoteId,
} from '../apps/edge-web/src/lib/olist-progress.js';
import {
  olistOperationReason,
  olistRecoveryFailure,
} from '../apps/edge-web/src/lib/olist-feedback.js';

const derive = /** @type {(operation: any, resources?: any) => any} */ (
  deriveOlistProgress
);
/**
 * @param {string} state
 * @param {string} stage
 * @param {Record<string, any>} [extra]
 */
const operation = (state, stage, extra = {}) => ({
  state,
  stage,
  number: null,
  ...extra,
});
/** @param {any} progress */
const statuses = (/** @type {any} */ progress) =>
  progress.steps.map((/** @type {any} */ step) => step.status);

test('each operation state maps to a per-step status', () => {
  /** @type {Array<[any, string[]]>} */
  const cases = [
    [operation('queued', 'customer'), ['waiting', 'waiting', 'waiting']],
    [operation('resolving', 'customer'), ['active', 'waiting', 'waiting']],
    [operation('resolving', 'product'), ['done', 'active', 'waiting']],
    [operation('resolving', 'variation'), ['done', 'active', 'waiting']],
    [operation('ready', 'sale'), ['done', 'done', 'waiting']],
    [operation('reserved', 'sale'), ['done', 'done', 'active']],
    [
      operation('confirmed', 'complete', { number: '500' }),
      ['done', 'done', 'done'],
    ],
    [
      operation('linked', 'complete', { number: '501' }),
      ['done', 'done', 'done'],
    ],
    [operation('uncertain', 'product'), ['done', 'blocked', 'waiting']],
    [operation('uncertain', 'sale'), ['done', 'done', 'blocked']],
    [operation('rejected', 'customer'), ['rejected', 'waiting', 'waiting']],
    [operation('invalidated', 'sale'), ['done', 'done', 'invalidated']],
  ];
  for (const [input, expected] of cases)
    assert.deepEqual(
      statuses(derive(input)),
      expected,
      input.state + ':' + input.stage,
    );
});

test('no operation yields no progress and keeps the T12 headlines', () => {
  assert.equal(derive(null), null);
  assert.equal(
    olistOperationHeadline(operation('queued', 'customer')),
    'Operação Olist em acompanhamento',
  );
  assert.equal(
    olistOperationHeadline(operation('confirmed', 'complete')),
    'Venda Olist conferida',
  );
  assert.equal(
    olistOperationHeadline(operation('linked', 'complete')),
    'Venda Olist conferida',
  );
  assert.equal(
    olistOperationHeadline(operation('uncertain', 'sale')),
    'Operação bloqueada para conferência administrativa',
  );
});

test('an unknown outcome code is uncertain even when the state looks active', () => {
  const unknown = operation('rejected', 'variation', {
    errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
  });
  assert.equal(isOperationUncertain(unknown), true);
  assert.equal(isOperationInProgress(unknown), false);
  const progress = derive(unknown);
  assert.deepEqual(statuses(progress), ['done', 'blocked', 'waiting']);
  assert.equal(progress.kind, 'blocked');
  assert.equal(progress.blockedLabel, 'Produto e variações');
  assert.match(progress.reason, /pode existir no Olist/u);
  assert.match(progress.guidance.join(' '), /Não repita a geração/u);
  assert.equal(isOperationUncertain(operation('confirmed', 'complete')), false);
});

test('uncertain, rejected and invalidated never produce a retry affordance', () => {
  for (const input of [
    operation('uncertain', 'sale'),
    operation('rejected', 'customer', { errorCode: 'OLIST_UPSTREAM_REJECTED' }),
    operation('invalidated', 'product'),
    operation('confirmed', 'complete', { number: '9' }),
  ]) {
    const text = JSON.stringify(derive(input));
    assert.doesNotMatch(
      text,
      /Tentar novamente|Repetir geração|Gerar de novo/u,
    );
  }
});

test('only in-flight states are followed by the bounded CRM re-read', () => {
  for (const state of ['queued', 'resolving', 'ready', 'reserved'])
    assert.equal(isOperationInProgress(operation(state, 'customer')), true);
  for (const state of [
    'confirmed',
    'linked',
    'uncertain',
    'rejected',
    'invalidated',
  ])
    assert.equal(isOperationInProgress(operation(state, 'customer')), false);
  assert.equal(isOperationInProgress(null), false);
});

test('admin counts show finished registrations without partial claims', () => {
  const resources = [
    { id: 'a', kind: 'customer', state: 'confirmed' },
    { id: 'b', kind: 'product', state: 'confirmed' },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: 'v' + index,
      kind: 'variation',
      state: index < 3 ? 'confirmed' : index === 3 ? 'reserved' : 'pending',
    })),
  ];
  assert.deepEqual(countResources(resources), {
    customer: { done: 1, total: 1 },
    product: { done: 1, total: 1 },
    variation: { done: 3, total: 5 },
  });
  assert.equal(countResources(null), null);
  const progress = derive(operation('resolving', 'variation'), resources);
  const product = progress.steps[1];
  assert.match(product.detail, /3 de 5 variações vinculadas/u);
  assert.match(product.detail, /1 de 1 produto vinculado/u);
  assert.match(progress.steps[0].detail, /1 de 1 cliente vinculado/u);
  // A user without administration data gets no counts, only the states.
  const plain = derive(operation('resolving', 'variation'));
  assert.doesNotMatch(JSON.stringify(plain), /variações vinculadas/u);
});

test('announcements name only the relevant change and never the whole list', () => {
  const before = derive(operation('resolving', 'customer'));
  assert.equal(progressAnnouncement(before, before), '');
  assert.equal(progressAnnouncement(null, before), '');
  const next = derive(operation('resolving', 'product'));
  const text = progressAnnouncement(before, next);
  assert.match(text, /Produto e variações: em andamento/u);
  assert.doesNotMatch(text, /Cliente/u);
  assert.match(
    progressAnnouncement(next, derive(operation('uncertain', 'product'))),
    /bloqueada por incerteza.*Não repita/su,
  );
  assert.equal(
    progressAnnouncement(
      next,
      derive(operation('confirmed', 'complete', { number: '77' })),
    ),
    'Operação concluída. Venda Olist 77.',
  );
});

test('admin counts are announced only when they change, never on first arrival', () => {
  const resources = (/** @type {number} */ done) =>
    Array.from({ length: 5 }, (_, index) => ({
      id: 'v' + index,
      kind: 'variation',
      state: index < done ? 'confirmed' : 'pending',
    }));
  const plain = derive(operation('resolving', 'variation'));
  const first = derive(operation('resolving', 'variation'), resources(2));
  assert.equal(progressAnnouncement(plain, first), '');
  const next = derive(operation('resolving', 'variation'), resources(3));
  assert.match(
    progressAnnouncement(first, next),
    /Produto e variações: em andamento. 3 de 5 variações vinculadas./u,
  );
});

test('sent and linked operations expose the origin only when the projection says so', () => {
  assert.equal(
    derive(operation('linked', 'complete', { number: '5' })).origin,
    'linked',
  );
  assert.equal(
    derive(operation('confirmed', 'complete', { number: '5' })).origin,
    null,
  );
  assert.equal(
    derive(operation('confirmed', 'complete', { number: '5' })).saleNumber,
    '5',
  );
});

test('reconcile targets use the version of the target and skip healthy resources', () => {
  const targets = reconcileTargets({
    operation: {
      id: 'o',
      version: 9,
      state: 'uncertain',
      stage: 'sale',
      number: null,
    },
    resources: [
      {
        id: 'c-1',
        kind: 'customer',
        state: 'confirmed',
        version: 2,
        remoteId: '1',
      },
      {
        id: 'p-1',
        kind: 'product',
        state: 'uncertain',
        version: 4,
        remoteId: null,
      },
      {
        id: 'v-1',
        kind: 'variation',
        state: 'pending',
        version: 1,
        remoteId: null,
      },
      {
        id: 'v-2',
        kind: 'variation',
        state: 'rejected',
        version: 3,
        remoteId: null,
      },
    ],
  });
  assert.deepEqual(
    targets.map(({ stage, resourceId, expectedVersion }) => ({
      stage,
      resourceId,
      expectedVersion,
    })),
    [
      { stage: 'product', resourceId: 'p-1', expectedVersion: 4 },
      { stage: 'variation', resourceId: 'v-2', expectedVersion: 3 },
      { stage: 'sale', resourceId: null, expectedVersion: 9 },
    ],
  );
  assert.deepEqual(reconcileTargets(null), []);
  assert.deepEqual(reconcileTargets({ operation: null, resources: [] }), []);
});

test('a rejected or invalidated sale is informed, never offered for reconciliation', () => {
  for (const state of ['rejected', 'invalidated']) {
    const targets = reconcileTargets({
      operation: { id: 'o', version: 9, state, stage: 'sale', number: null },
      resources: [],
    });
    assert.deepEqual(
      targets.filter((target) => target.stage === 'sale'),
      [],
    );
  }
  // Uncertain by code but rejected by state: the server still refuses.
  assert.deepEqual(
    reconcileTargets({
      operation: {
        id: 'o',
        version: 9,
        state: 'rejected',
        stage: 'sale',
        errorCode: 'OLIST_SALE_UNCERTAIN',
      },
      resources: [],
    }),
    [],
  );
});

test('manual link is offered only where the server can accept it', () => {
  assert.equal(canOfferLink(null), true);
  // commitLink only accepts queued, resolving and ready.
  for (const state of ['queued', 'resolving', 'ready'])
    assert.equal(canOfferLink({ state }), true);
  for (const state of [
    'reserved',
    'uncertain',
    'confirmed',
    'linked',
    'invalidated',
    'rejected',
  ])
    assert.equal(canOfferLink({ state }), false);
  // Uncertain by code, whatever the state, is never offered a manual link.
  assert.equal(
    canOfferLink({ state: 'rejected', errorCode: 'OLIST_SALE_UNCERTAIN' }),
    false,
  );
  assert.equal(
    canOfferLink({
      state: 'ready',
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    false,
  );
});

test('history keeps only allowlisted fields and drops anything unsafe', () => {
  const [attempt] = safeAttempts([
    {
      id: 'x',
      resourceId: 'r',
      stage: 'variation',
      outcome: 'uncertain',
      observedRemoteId: '<script>alert(1)</script>',
      code: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
      createdAt: '2026-11-08T10:00:00.000Z',
      finishedAt: null,
      payload: { secret: 'must-not-appear' },
      token: 'must-not-appear',
    },
  ]);
  assert.equal(attempt.remoteId, null);
  assert.equal(attempt.code, 'OLIST_RESOURCE_OUTCOME_UNKNOWN');
  assert.equal(attempt.stage, 'Variação');
  assert.equal(attempt.outcome, 'Incerta');
  assert.doesNotMatch(JSON.stringify(attempt), /must-not-appear|script/u);
  assert.equal(safeCode('lower_case'), null);
  assert.equal(safeCode('OLIST_OK'), 'OLIST_OK');
  assert.equal(safeRemoteId('12345'), '12345');
  assert.equal(safeRemoteId('a b'), null);
  assert.deepEqual(safeAttempts(undefined), []);
});

test('reasons and recovery failures are fixed Portuguese copy', () => {
  assert.match(olistOperationReason('OLIST_SALE_UNCERTAIN'), /venda/u);
  assert.equal(olistOperationReason('SOMETHING_PRIVATE', ''), '');
  assert.match(
    olistOperationReason('SOMETHING_PRIVATE', 'rejected'),
    /detalhe do provedor não é exibido/u,
  );
  /** @type {Array<[any, RegExp]>} */
  const failures = [
    [{ status: 403 }, /acesso mudou/u],
    [{ status: 409, code: 'VERSION_CONFLICT' }, /estado da etapa mudou/u],
    [
      { status: 409, code: 'OLIST_RECONCILIATION_REQUIRED' },
      /Conferir no Olist/u,
    ],
    [
      { status: 409, code: 'OLIST_PREVIEW_STALE' },
      /Confira a venda novamente/u,
    ],
    [
      { status: 409, code: 'OLIST_SALE_REFERENCE_CONFLICT' },
      /Nenhum vínculo foi criado/u,
    ],
    [{ status: 422, code: 'OLIST_ORDER_INCOMPLETE' }, /não está completo/u],
    [{ status: 422 }, /Os dados não permitem/u],
    [{ status: 429 }, /Limite de consultas/u],
    [{ status: 503 }, /resultado do vínculo é incerto.*pode ter sido gravado/u],
    [{ status: 0 }, /resultado do vínculo é incerto/u],
    [{ status: 400 }, /não pode ter quebra de linha/u],
  ];
  for (const [cause, pattern] of failures)
    assert.match(olistRecoveryFailure(cause, 'link'), pattern);
  // An uncertain reconcile says the request may exist; a preview stays generic.
  assert.match(
    olistRecoveryFailure({ status: 502 }, 'reconcile'),
    /pode ter sido registrado/u,
  );
  assert.match(
    olistRecoveryFailure({ status: 503 }, 'preview'),
    /Não foi possível concluir agora/u,
  );
  assert.doesNotMatch(
    olistRecoveryFailure({ status: 400 }, 'preview'),
    /quebra de linha/u,
  );
  // The provider's own message never reaches the copy.
  assert.doesNotMatch(
    olistRecoveryFailure({
      status: 422,
      message: 'provider-canary',
      detail: 'provider-canary',
    }),
    /provider-canary/u,
  );
});

const invalidatedByAdmin = () =>
  operation('invalidated', 'customer', {
    id: 'op-1',
    version: 8,
    errorCode: 'OLIST_EXPORT_INVALIDATED',
  });

test('an administrative invalidation says nothing was sold and asks for a new preview', () => {
  const progress = derive(invalidatedByAdmin());
  assert.equal(progress.kind, 'invalidated');
  assert.equal(progress.headline, 'Operação Olist invalidada');
  assert.deepEqual(progress.guidance, [
    'Esta geração foi invalidada antes de qualquer venda. Gere uma nova prévia; cadastros já criados no Olist foram preservados.',
  ]);
  assert.doesNotMatch(
    progress.guidance.join(' '),
    /conferência administrativa|Tentar novamente|Repetir geração/u,
  );
  assert.match(progress.reason, /antes de qualquer venda/u);
  assert.deepEqual(statuses(progress), ['invalidated', 'waiting', 'waiting']);
  // Neither uncertain nor underway: no bounded re-read, no reconcile target.
  assert.equal(isOperationUncertain(invalidatedByAdmin()), false);
  assert.equal(isOperationInProgress(invalidatedByAdmin()), false);
  assert.equal(isAdminInvalidated(invalidatedByAdmin()), true);
  assert.deepEqual(
    reconcileTargets({ operation: invalidatedByAdmin(), resources: [] }),
    [],
  );
  assert.match(
    progressAnnouncement(derive(operation('ready', 'sale')), progress),
    /invalidada/u,
  );
});

test('a cancellation or any other invalidation keeps the conference guidance', () => {
  for (const errorCode of ['ORDER_CANCELLED', undefined, 'OLIST_UPSTREAM']) {
    const input = operation('invalidated', 'product', { errorCode });
    assert.equal(isAdminInvalidated(input), false);
    assert.match(
      derive(input).guidance.join(' '),
      /peça a conferência administrativa/u,
    );
  }
  // The error code alone, without the state, is not an invalidation.
  assert.equal(
    isAdminInvalidated(
      operation('ready', 'sale', { errorCode: 'OLIST_EXPORT_INVALIDATED' }),
    ),
    false,
  );
  assert.equal(isAdminInvalidated(null), false);
});

test('an administratively invalidated generation counts as no active operation for the manual link', () => {
  assert.equal(canOfferLink(invalidatedByAdmin()), true);
  assert.equal(canOfferLink(operation('invalidated', 'customer')), false);
  assert.equal(
    canOfferLink(
      operation('invalidated', 'customer', { errorCode: 'ORDER_CANCELLED' }),
    ),
    false,
  );
});

test('invalidation is offered only before any sale attempt or uncertain resource', () => {
  const base = { id: 'op-1', version: 7 };
  const offered = (/** @type {Record<string, any>} */ input) =>
    canOfferInvalidate(
      /** @type {any} */ ({
        operation: operation('ready', 'sale', base),
        attempts: [],
        resources: [],
        ...input,
      }),
    );
  assert.equal(offered({}), true);
  for (const state of ['queued', 'resolving', 'ready'])
    assert.equal(
      offered({ operation: operation(state, 'customer', base) }),
      true,
      state,
    );
  for (const state of [
    'reserved',
    'uncertain',
    'confirmed',
    'linked',
    'rejected',
    'invalidated',
  ])
    assert.equal(
      offered({ operation: operation(state, 'sale', base) }),
      false,
      state,
    );
  // A sale attempt, whatever its outcome, closes the door.
  for (const outcome of ['reserved', 'uncertain', 'confirmed', 'rejected'])
    assert.equal(
      offered({
        attempts: [
          { id: 'a', stage: 'customer', outcome: 'confirmed' },
          { id: 'b', stage: 'sale', outcome },
        ],
      }),
      false,
      outcome,
    );
  // Attempts of other stages do not.
  assert.equal(
    offered({
      attempts: [{ id: 'a', stage: 'variation', outcome: 'rejected' }],
    }),
    true,
  );
  for (const state of ['reserved', 'uncertain'])
    assert.equal(
      offered({
        resources: [
          { id: 'r1', kind: 'customer', state: 'confirmed' },
          { id: 'r2', kind: 'variation', state },
        ],
      }),
      false,
      state,
    );
  for (const state of ['pending', 'confirmed', 'rejected'])
    assert.equal(
      offered({ resources: [{ id: 'r', kind: 'product', state }] }),
      true,
      state,
    );
  assert.equal(offered({ cancelled: true }), false);
  assert.equal(offered({ operation: null }), false);
  // Without the diagnostic id and version there is no command to send.
  assert.equal(offered({ operation: operation('ready', 'sale') }), false);
  assert.equal(
    offered({
      operation: operation('ready', 'sale', { id: 'op', version: 0 }),
    }),
    false,
  );
  assert.equal(
    canOfferInvalidate({ operation: operation('ready', 'sale', base) }),
    true,
  );
});

test('invalidation failures are fixed Portuguese copy and never echo the server', () => {
  /** @type {Array<[any, RegExp]>} */
  const failures = [
    [
      { status: 409, code: 'OLIST_INVALIDATION_BLOCKED' },
      /não pode ser invalidada.*Nada foi alterado/u,
    ],
    [
      { status: 409, code: 'OLIST_EXPORT_IN_FLIGHT' },
      /em execução agora.*Nada foi alterado/u,
    ],
    [
      { status: 409, code: 'OLIST_RESOURCE_RECONCILIATION_REQUIRED' },
      /ainda sem resultado confirmado.*Conferir no Olist nesse cadastro.*poderá ser invalidada/u,
    ],
    [{ status: 409, code: 'VERSION_CONFLICT' }, /estado da etapa mudou/u],
    [
      { status: 409, code: 'OLIST_EXPORT_UNAVAILABLE' },
      /não está mais disponível/u,
    ],
    [{ status: 409, code: 'ORDER_CANCELLED' }, /pedido foi cancelado/u],
    [{ status: 403 }, /acesso mudou/u],
    [{ status: 401 }, /acesso mudou/u],
    [{ status: 503 }, /pode não ter sido registrada.*reenvio/u],
    [{ status: 0 }, /pode não ter sido registrada/u],
    [{ status: 400 }, /não pode ter quebra de linha/u],
  ];
  for (const [cause, pattern] of failures)
    assert.match(olistRecoveryFailure(cause, 'invalidate'), pattern);
  assert.doesNotMatch(
    olistRecoveryFailure(
      { status: 409, code: 'OLIST_INVALIDATION_BLOCKED', detail: 'canary' },
      'invalidate',
    ),
    /canary/u,
  );
  // The same codes keep their other meanings outside this action.
  assert.doesNotMatch(
    olistRecoveryFailure(
      { status: 409, code: 'OLIST_INVALIDATION_BLOCKED' },
      'reconcile',
    ),
    /invalidada/u,
  );
  assert.match(
    olistOperationReason('OLIST_EXPORT_INVALIDATED'),
    /antes de qualquer venda/u,
  );
});
