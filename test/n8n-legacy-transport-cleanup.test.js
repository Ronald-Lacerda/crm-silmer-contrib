import assert from 'node:assert/strict';
import test from 'node:test';
import { planLegacyTransportArchive } from '../ops/n8n/legacy-transport-cleanup.mjs';

const candidate = () => ({
  id: 'old-gateway',
  active: false,
  activeVersionId: null,
  isArchived: false,
  nodes: [{ id: 'qr', name: 'WAHA - QR privado', parameters: {} }],
  connections: {},
  settings: { saveManualExecutions: false },
});

test('EVOL-01 cleanup archives an explicitly selected inactive transport without changing its contents or source', () => {
  const source = candidate();
  const before = structuredClone(source);
  const [archived] = planLegacyTransportArchive([source], [source.id]);
  assert.deepEqual(source, before);
  assert.deepEqual(archived, { ...before, isArchived: true });
});

test('EVOL-01 cleanup refuses active, published, missing and repeated targets', () => {
  for (const change of [{ active: true }, { activeVersionId: 'published' }]) {
    assert.throws(
      () =>
        planLegacyTransportArchive(
          [{ ...candidate(), ...change }],
          ['old-gateway'],
        ),
      /CLEANUP_ACTIVE_WORKFLOW/,
    );
  }
  assert.throws(
    () => planLegacyTransportArchive([], ['missing']),
    /CLEANUP_WORKFLOW_MISSING/,
  );
  assert.throws(
    () =>
      planLegacyTransportArchive([candidate()], ['old-gateway', 'old-gateway']),
    /CLEANUP_SELECTION_INVALID/,
  );
});

test('EVOL-01 cleanup protects Meta and unrelated candidates even if renamed WAHA', () => {
  for (const node of [
    { type: 'n8n-nodes-base.whatsAppTrigger', name: 'WAHA renamed' },
    {
      name: 'WAHA renamed',
      parameters: { url: 'https://graph.facebook.com/v25.0/messages' },
    },
  ]) {
    assert.throws(
      () =>
        planLegacyTransportArchive(
          [{ ...candidate(), nodes: [node] }],
          ['old-gateway'],
        ),
      /CLEANUP_META_WORKFLOW_PROTECTED/,
    );
  }
  assert.throws(
    () =>
      planLegacyTransportArchive(
        [{ ...candidate(), nodes: [{ name: 'Checkout' }] }],
        ['old-gateway'],
      ),
    /CLEANUP_NOT_LEGACY_TRANSPORT/,
  );
});

test('EVOL-01 cleanup protects archived subworkflow callers and error workflow references', () => {
  for (const caller of [
    {
      id: 'caller',
      isArchived: true,
      nodes: [{ parameters: { workflowId: 'old-gateway' } }],
    },
    { id: 'caller', nodes: [], settings: { errorWorkflow: 'old-gateway' } },
  ]) {
    assert.throws(
      () => planLegacyTransportArchive([candidate(), caller], ['old-gateway']),
      /CLEANUP_REFERENCED_WORKFLOW/,
    );
  }
});
