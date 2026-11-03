import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canReadHealthErrors,
  healthErrorGuidance,
  healthErrorInstant,
} from '../apps/edge-web/src/lib/health-errors.js';

const admin = {
  id: 'operator-synthetic',
  email: 'admin@crm-silmer.local',
  functionName: 'Vendedor',
  capabilities: ['COMMERCIAL_ADMIN'],
};

test('OPS-ERR-01: only the designated active human administrator sees the console', () => {
  assert.equal(canReadHealthErrors(admin), true);
  assert.equal(
    canReadHealthErrors({ ...admin, email: 'other@crm-silmer.local' }),
    false,
  );
  assert.equal(canReadHealthErrors({ ...admin, capabilities: [] }), false);
  assert.equal(
    canReadHealthErrors({ ...admin, functionName: 'Financeiro' }),
    false,
  );
  assert.equal(canReadHealthErrors({ ...admin, kind: 'assistant' }), false);
  assert.equal(
    canReadHealthErrors({ ...admin, disabledAt: '2026-11-02T15:00:00Z' }),
    false,
  );
  assert.equal(canReadHealthErrors({ ...admin, email: undefined }), false);
  assert.equal(canReadHealthErrors(null), false);
});

test('OPS-ERR-04: unknown delivery outcomes require checking before retry', () => {
  assert.match(
    healthErrorGuidance('OUTCOME_UNKNOWN'),
    /antes de qualquer nova tentativa/u,
  );
  assert.match(healthErrorGuidance('UNSAFE_RETRY'), /pode ter sido concluído/u);
});

test('OPS-ERR-05: incident timestamps always use São Paulo and do not invent missing dates', () => {
  assert.equal(
    healthErrorInstant('2026-11-02T15:30:00.000Z'),
    '02/11/2026, 12:30',
  );
  assert.equal(healthErrorInstant(null), 'Não informado');
  assert.equal(healthErrorInstant('invalid'), 'Não informado');
});
