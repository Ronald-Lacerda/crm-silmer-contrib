import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTOMATION_EXECUTOR_ACTIONS,
  AUTOMATION_EXECUTOR_ACTOR,
  createAutomationCredentials,
} from '../modules/identity-access/src/index.js';

const CLIENT_ID = 'silmer-n8n';
const CURRENT_SECRET = 'current-automation-secret-with-32-characters';
const PREVIOUS_SECRET = 'previous-automation-secret-with-32-characters';

test('builds the fixed technical actor with only the approved CRM actions', () => {
  const credentials = createAutomationCredentials({
    clientId: CLIENT_ID,
    currentSecret: CURRENT_SECRET,
  });

  assert.deepEqual(AUTOMATION_EXECUTOR_ACTOR, {
    id: 'AUTOMATION_EXECUTOR',
    kind: 'AUTOMATION_EXECUTOR',
    role: 'AUTOMATION_EXECUTOR',
  });
  assert.equal(Object.isFrozen(AUTOMATION_EXECUTOR_ACTOR), true);
  assert.deepEqual(AUTOMATION_EXECUTOR_ACTIONS, [
    'integration.n8n.message.create',
    'integration.n8n.attachment.create',
    'integration.n8n.event.create',
    'integration.n8n.command.media.read',
    'dashboard.checkpoint.execute',
    'conversation.convert',
    'deal.fields.patch',
    'deal.transition',
    'handoff.create',
    'billing.checkout.reserve',
    'billing.checkout.record',
    'billing.checkout.read',
    'billing.payment.record',
    'order.intent',
    'store.order.record',
  ]);
  for (const action of AUTOMATION_EXECUTOR_ACTIONS) {
    assert.equal(credentials.isActionAllowed(action), true);
  }
  for (const action of [
    'identity.capability.grant',
    'order-form.approve',
    'database.direct-access',
    'unknown.action',
  ]) {
    assert.equal(credentials.isActionAllowed(action), false);
  }
});

test('authenticates current and overlapping previous secrets without a human session', () => {
  const credentials = createAutomationCredentials({
    clientId: CLIENT_ID,
    currentSecret: CURRENT_SECRET,
    previousSecret: PREVIOUS_SECRET,
  });

  assert.deepEqual(credentials.authenticate(CLIENT_ID, CURRENT_SECRET), {
    actor: AUTOMATION_EXECUTOR_ACTOR,
    credentialVersion: 'current',
  });
  assert.deepEqual(credentials.authenticate(CLIENT_ID, PREVIOUS_SECRET), {
    actor: AUTOMATION_EXECUTOR_ACTOR,
    credentialVersion: 'previous',
  });
  assert.equal(
    credentials.authenticate('another-client', CURRENT_SECRET),
    null,
  );
  assert.equal(credentials.authenticate(CLIENT_ID, 'wrong-secret'), null);
  assert.equal(
    credentials.authenticate(
      CLIENT_ID,
      'no-previous-automation-secret-is-configured',
    ),
    null,
  );
  assert.deepEqual(Object.keys(credentials).sort(), [
    'authenticate',
    'isActionAllowed',
  ]);
  assert.equal('capabilities' in AUTOMATION_EXECUTOR_ACTOR, false);
  assert.equal('session' in AUTOMATION_EXECUTOR_ACTOR, false);
  assert.equal('database' in AUTOMATION_EXECUTOR_ACTOR, false);
});

test('drops the previous secret after rotation when the runtime is restarted', () => {
  const overlapping = createAutomationCredentials({
    clientId: CLIENT_ID,
    currentSecret: CURRENT_SECRET,
    previousSecret: PREVIOUS_SECRET,
  });
  const rotated = createAutomationCredentials({
    clientId: CLIENT_ID,
    currentSecret: CURRENT_SECRET,
  });

  assert.equal(
    overlapping.authenticate(CLIENT_ID, PREVIOUS_SECRET)?.credentialVersion,
    'previous',
  );
  assert.equal(rotated.authenticate(CLIENT_ID, PREVIOUS_SECRET), null);
});

test('fails closed on missing or weak credential configuration', () => {
  const invalidConfigurations = [
    { clientId: '', currentSecret: CURRENT_SECRET },
    { clientId: 'invalid:client', currentSecret: CURRENT_SECRET },
    { clientId: CLIENT_ID, currentSecret: 'short' },
    {
      clientId: CLIENT_ID,
      currentSecret: CURRENT_SECRET,
      previousSecret: 'short',
    },
  ];

  for (const configuration of invalidConfigurations) {
    assert.throws(
      () => createAutomationCredentials(configuration),
      /clientId|secret/iu,
    );
  }
});
