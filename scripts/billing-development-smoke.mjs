import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createOrderBillingDevelopmentWorkflow } from '../ops/n8n/workflows/create-order-billing-workflow.mjs';
import { DEVELOPMENT_CREDENTIALS } from './billing-development-service.mjs';
import { createBillingDevelopmentTransportWorkflow } from '../ops/n8n/workflows/create-order-billing-transport-dev-workflow.mjs';

const execute = promisify(execFile);
const IMAGE = 'n8nio/n8n:2.38.7';

/** Real n8n + HTTP CRM routes + PostgreSQL. All containers belong to this run;
 * no production URL, credential, existing database or WhatsApp is used.
 */
export async function runBillingDevelopmentSmoke(
  options = { transport: false },
) {
  if (process.env.RUN_BILLING_LOCAL_SMOKE !== 'yes')
    throw new Error('RUN_BILLING_LOCAL_SMOKE=yes is required');
  const root = resolve(import.meta.dirname, '..');
  await mkdir(join(root, 'var'), { recursive: true });
  const directory = await mkdtemp(join(root, 'var', 'billing-development-'));
  const suffix = randomUUID().slice(0, 8);
  const prefix = `crm-billing-dev-${suffix}`;
  const network = `${prefix}-network`;
  const names = {
    postgres: `${prefix}-postgres`,
    service: `${prefix}-service`,
    n8n: `${prefix}-n8n`,
  };
  /** @type {string[]} */
  const started = [];
  const workflow = /** @type {any} */ (createOrderBillingDevelopmentWorkflow());
  workflow.id = 'SyntheticBillingDev';
  const transport = createBillingDevelopmentTransportWorkflow(
    JSON.parse(
      await readFile(
        join(
          root,
          'ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
        ),
        'utf8',
      ),
    ),
  );
  const credentials = [
    {
      id: 'synthetic-billing-worker',
      name: 'Silmer CRM para n8n Basic DEV',
      type: 'httpBasicAuth',
      data: {
        user: DEVELOPMENT_CREDENTIALS.workerUser,
        password: DEVELOPMENT_CREDENTIALS.workerPassword,
      },
    },
    {
      id: 'synthetic-billing-crm',
      name: 'Silmer n8n para CRM Basic DEV',
      type: 'httpBasicAuth',
      data: {
        user: DEVELOPMENT_CREDENTIALS.crmUser,
        password: DEVELOPMENT_CREDENTIALS.crmPassword,
      },
    },
    {
      id: 'synthetic-billing-gateway',
      name: 'InfinitePay Checkout API Key DEV',
      type: 'httpHeaderAuth',
      data: { name: 'X-Api-Key', value: DEVELOPMENT_CREDENTIALS.gatewayKey },
    },
  ];
  for (const node of [...workflow.nodes, ...transport.nodes])
    for (const [kind, reference] of Object.entries(node.credentials ?? {})) {
      const credential = credentials.find(
        (candidate) => candidate.name === reference.name,
      );
      assert.ok(credential, 'development credential must be synthetic');
      node.credentials[kind] = { id: credential.id, name: credential.name };
    }
  await writeFile(
    join(directory, 'workflow.json'),
    JSON.stringify([workflow, transport]),
    {
      mode: 0o600,
    },
  );
  await writeFile(
    join(directory, 'credentials.json'),
    JSON.stringify(credentials),
    { mode: 0o600 },
  );
  await mkdir(join(directory, 'state'));
  const report = {
    synthetic: true,
    n8nImage: IMAGE,
    scenarios: /** @type {string[]} */ ([]),
    limitations: [
      'Human session adapter is synthetic; login/CSRF have separate tests.',
      ...(options.transport
        ? [
            'WhatsApp provider is a synthetic sink; reservation, final preflight and result callbacks run in real n8n.',
          ]
        : [
            'WhatsApp transport is not executed; durable Inbox outbox composition is asserted.',
          ]),
      'No InfinitePay, production n8n or EasyPanel operation is certified.',
    ],
  };
  let networkCreated = false;
  let interrupted = false;
  /** @type {Promise<void>|undefined} */
  let cleanupPromise;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      for (const name of [...started].reverse()) {
        const present = await docker([
          'ps',
          '--all',
          '--filter',
          `name=^/${name}$`,
          '--format',
          '{{.Names}}',
        ]);
        if (present.stdout.trim())
          await docker(['rm', '--force', '--volumes', name]);
        const result = await docker([
          'ps',
          '--all',
          '--filter',
          `name=^/${name}$`,
          '--format',
          '{{.Names}}',
        ]);
        assert.equal(result.stdout.trim(), '', 'run-owned container leaked');
      }
      if (networkCreated) {
        const present = await docker([
          'network',
          'ls',
          '--filter',
          `name=^${network}$`,
          '--format',
          '{{.Name}}',
        ]);
        if (present.stdout.trim()) await docker(['network', 'rm', network]);
      }
    })());
  // Let the current bounded Docker call finish before cleanup. Removing while
  // docker run is still creating its container can otherwise orphan that run.
  const abort = () => {
    interrupted = true;
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  /** @param {()=>Promise<boolean>} check */
  const waitUntil = (check) => until(check, () => interrupted);
  try {
    networkCreated = true;
    await docker(['network', 'create', '--internal', network]);
    await run('postgres', [
      '--network-alias',
      'billing-postgres',
      '--env',
      'POSTGRES_USER=synthetic',
      '--env',
      'POSTGRES_PASSWORD=synthetic-local-only',
      '--env',
      'POSTGRES_DB=crm_silmer_test',
      'postgres:17-alpine',
    ]);
    await waitUntil(async () => {
      try {
        await docker([
          'exec',
          names.postgres,
          'pg_isready',
          '-U',
          'synthetic',
          '-d',
          'crm_silmer_test',
        ]);
        return true;
      } catch {
        return false;
      }
    });
    await run('service', [
      '--network-alias',
      'billing-crm',
      '--network-alias',
      'billing-simulator',
      '--env',
      'APP_ENV=development',
      '--env',
      'RUN_BILLING_LOCAL_SMOKE=yes',
      '--env',
      'TEST_DATABASE_URL=postgresql://synthetic:synthetic-local-only@billing-postgres:5432/crm_silmer_test',
      '--mount',
      `type=bind,source=${root},target=/workspace,readonly`,
      '--entrypoint',
      'node',
      IMAGE,
      '--import',
      '/workspace/scripts/billing-development-loader.mjs',
      '/workspace/scripts/billing-development-service.mjs',
    ]);
    const crmBase = 'http://billing-crm:3000';
    const n8nBase = 'http://n8n:5678';
    const request = dockerHttp(names.service);
    /** @param {string} base @param {string} path @param {any} body @param {boolean} [requireSuccess] @param {Record<string,string>} [headers] */
    const post = (base, path, body, requireSuccess = true, headers = {}) => {
      if (interrupted) throw new Error('BILLING_DEVELOPMENT_INTERRUPTED');
      return request(base, path, body, requireSuccess, headers);
    };
    /** @param {string} base @param {any} body */
    const command = (base, body) =>
      post(base, '/webhook/silmer/order-billing-dev/create', body, false, {
        authorization: `Basic ${Buffer.from(DEVELOPMENT_CREDENTIALS.workerUser + ':' + DEVELOPMENT_CREDENTIALS.workerPassword).toString('base64')}`,
      });
    await waitUntil(async () => {
      try {
        return (
          (await request(crmBase, '/__billing-development/health')).status ===
          200
        );
      } catch {
        return false;
      }
    });
    await run('n8n', [
      '--network-alias',
      'n8n',
      '--memory=2g',
      '--cpus=1',
      '--env',
      'N8N_DIAGNOSTICS_ENABLED=false',
      '--env',
      'N8N_PERSONALIZATION_ENABLED=false',
      '--env',
      'N8N_SECURE_COOKIE=false',
      '--env',
      'N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true',
      '--env',
      'N8N_CONCURRENCY_PRODUCTION_LIMIT=1',
      '--env',
      'N8N_LOG_LEVEL=error',
      '--mount',
      `type=bind,source=${directory},target=/smoke,readonly`,
      '--mount',
      `type=bind,source=${join(directory, 'state')},target=/home/node/.n8n`,
      '--entrypoint',
      '/bin/sh',
      IMAGE,
      '-ec',
      'n8n import:credentials --input=/smoke/credentials.json >/tmp/credentials.log 2>&1; n8n import:workflow --input=/smoke/workflow.json >/tmp/import.log 2>&1; n8n publish:workflow --id=SyntheticBillingDev >/tmp/publish.log 2>&1; n8n publish:workflow --id=SyntheticBillingTransportDev >>/tmp/publish.log 2>&1; exec n8n start',
    ]);
    await waitUntil(async () => {
      try {
        return (await request(n8nBase, '/healthz')).status === 200;
      } catch {
        return false;
      }
    });
    // A healthy editor can precede published webhook activation. A malformed
    // synthetic command must reach the workflow and fail validation, not 404.
    await waitUntil(async () => {
      const response = await command(n8nBase, {
        schema_version: '1.0',
        charge_id: 'invalid',
      });
      return response.status !== 404;
    });
    const seed = async () =>
      (await post(crmBase, '/__billing-development/seed', {})).body.orderId;
    const submit = async (/** @type {string} */ orderId, action = 'issue') =>
      (
        await post(crmBase, '/__billing-development/submit', {
          orderId,
          action,
        })
      ).body;
    const state = async (/** @type {string} */ orderId) => {
      return (await request(crmBase, `/__billing-development/state/${orderId}`))
        .body;
    };
    const issue = async (/** @type {string} */ orderId, action = 'issue') => {
      const intent = await submit(orderId, action);
      assert.equal(intent.state, 'waiting_link');
      await post(crmBase, '/__billing-development/run-worker', {});
      const snapshot = await state(orderId);
      assert.equal(snapshot.messages, action === 'issue' ? 1 : 2);
      return intent;
    };
    const pay = async (
      /** @type {string} */ chargeId,
      /** @type {Record<string,any>} */ options = {},
    ) =>
      (
        await post(crmBase, '/__billing-development/confirm', {
          chargeId,
          ...options,
        })
      ).body;
    const notify = async (/** @type {any} */ candidate) =>
      post(n8nBase, '/webhook/silmer/order-billing-dev/paid', candidate, false);
    const orderId = await seed();
    const signal = await issue(orderId);
    const replay = await command(n8nBase, {
      schema_version: '1.0',
      charge_id: signal.chargeId,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicate, true);
    assert.equal((await state(orderId)).effects.links, 1);
    report.scenarios.push(
      'signal 3000 cents; real worker/n8n/CRM; duplicate reservation creates one link',
    );
    const candidate = await pay(signal.chargeId);
    assert.equal((await notify(candidate)).status, 200);
    assert.equal((await notify(candidate)).status, 200);
    let snapshot = await state(orderId);
    assert.equal(snapshot.payments, 1);
    assert.equal(snapshot.view.billing.receivedAmountCents, 3000);
    assert.equal(snapshot.view.billing.balanceAmountCents, 7000);
    assert.equal(snapshot.paidOn, null);
    assert.equal(snapshot.view.billing.charges[0].method, 'pix');
    report.scenarios.push(
      'Pix payment replay preserves one payment; received 3000 and remaining 7000',
    );
    const balance = await issue(orderId, 'balance');
    const card = await pay(balance.chargeId, {
      method: 'credit_card',
      installments: 3,
    });
    assert.equal((await notify(card)).status, 200);
    snapshot = await state(orderId);
    assert.equal(snapshot.payments, 2);
    assert.equal(snapshot.view.billing.receivedAmountCents, 10000);
    assert.equal(snapshot.view.billing.balanceAmountCents, 0);
    assert.equal(snapshot.effects.links, 2);
    assert.ok(snapshot.paidOn);
    const paidCard = snapshot.view.billing.charges.find(
      (/** @type {any} */ charge) => charge.id === balance.chargeId,
    );
    assert.equal(paidCard.method, 'credit_card');
    assert.equal(paidCard.installments, 3);
    report.scenarios.push(
      'remaining 7000 by credit card 3x settles total 10000 with two payments',
    );
    const forged = await notify({
      ...candidate,
      order_nsu: randomUUID(),
      transaction_nsu: 'synthetic-forged',
    });
    assert.ok(forged.status >= 400);
    assert.equal((await state(orderId)).payments, 2);
    report.scenarios.push(
      'unknown forged charge is refused without recording payment',
    );
    const second = await seed();
    const undersized = await issue(second);
    const unpaid = await pay(undersized.chargeId, { paid: false });
    assert.ok((await notify(unpaid)).status >= 400);
    assert.equal((await state(second)).payments, 0);
    report.scenarios.push('unconfirmed payment is refused');
    const tooSmall = await pay(undersized.chargeId, {
      paid: true,
      amount: 2999,
    });
    assert.ok((await notify(tooSmall)).status >= 400);
    assert.equal((await state(second)).payments, 0);
    report.scenarios.push('underpayment 2999 for charge 3000 is refused');
    const recovered = await pay(undersized.chargeId, { amount: 3000 });
    await post(crmBase, '/__billing-development/fail-callback', {});
    assert.ok((await notify(recovered)).status >= 400);
    assert.equal((await state(second)).payments, 0);
    assert.equal((await notify(recovered)).status, 200);
    assert.equal((await notify(recovered)).status, 200);
    assert.equal((await state(second)).payments, 1);
    report.scenarios.push(
      'failed CRM callback is not ACKed; redelivery recovers exactly one payment',
    );
    const third = await seed();
    const lost = await submit(third);
    const beforeLost = (await state(third)).effects.links;
    await post(crmBase, '/__billing-development/fail-callback', {
      operation: 'created',
    });
    await post(crmBase, '/__billing-development/run-worker', {});
    const uncertain = await state(third);
    assert.equal(uncertain.messages, 0);
    assert.equal(uncertain.view.billing.charges[0].status, 'unknown');
    assert.equal(uncertain.effects.links, beforeLost + 1);
    const lostReplay = await command(n8nBase, {
      schema_version: '1.0',
      charge_id: lost.chargeId,
    });
    assert.equal(lostReplay.status, 200);
    assert.equal(lostReplay.body.duplicate, true);
    assert.equal((await state(third)).effects.links, beforeLost + 1);
    report.scenarios.push(
      'created callback failure remains uncertain; replay does not create a second gateway link',
    );
    if (options.transport) {
      const transportRun = () =>
        post(crmBase, '/__billing-development/run-transport', {});
      const sendIntent = async (
        /** @type {string} */ id,
        /** @type {any} */ fields,
      ) =>
        post(
          crmBase,
          '/__billing-development/submit',
          { orderId: id, ...fields },
          false,
        );
      const fault = async (
        /** @type {string} */ id,
        /** @type {string} */ kind,
      ) =>
        post(crmBase, '/__billing-development/transport/fault', {
          intentId: id,
          fault: kind,
        });
      const deliveryOrder = await seed();
      const delivered = await issue(deliveryOrder);
      await transportRun();
      let delivery = await state(deliveryOrder);
      assert.equal(delivery.intents[0].state, 'delivered');
      assert.equal(
        delivery.transportEffects[delivery.intents[0].command_id],
        1,
      );
      const existingOrder = await seed();
      const existingCharge = (
        await post(crmBase, '/__billing-development/legacy-issue', {
          orderId: existingOrder,
        })
      ).body.chargeId;
      await post(crmBase, '/__billing-development/run-worker', {});
      const linksBeforeExisting = (await state(existingOrder)).effects.links;
      const existing = await sendIntent(existingOrder, {
        action: 'send_existing',
        chargeId: existingCharge,
      });
      assert.equal(existing.status, 202);
      await transportRun();
      delivery = await state(existingOrder);
      assert.equal(
        delivery.intents.filter(
          (/** @type {any} */ i) => i.state === 'delivered',
        ).length,
        1,
      );
      assert.equal(delivery.effects.links, linksBeforeExisting);
      report.scenarios.push(
        'real n8n human reservation/preflight/sent/delivered; existing link reuses checkout with a new reviewed send',
      );
      assert.equal((await notify(await pay(delivered.chargeId))).status, 200);
      const deliveredBalance = await issue(deliveryOrder, 'balance');
      assert.equal(deliveredBalance.amountCents, 7000);
      await transportRun();
      const balanceDelivery = await state(deliveryOrder);
      assert.equal(
        balanceDelivery.intents.find(
          (/** @type {any} */ i) => i.id === deliveredBalance.id,
        ).state,
        'delivered',
      );
      assert.equal(
        (
          await notify(
            await pay(deliveredBalance.chargeId, {
              method: 'credit_card',
              installments: 3,
            }),
          )
        ).status,
        200,
      );
      assert.equal(
        (await state(deliveryOrder)).view.billing.balanceAmountCents,
        0,
      );
      report.scenarios.push(
        'reviewed remaining balance is delivered through the real transport workflow and settles exactly once',
      );
      const safeOrder = await seed();
      const safe = await issue(safeOrder);
      await fault(safe.id, 'before_send');
      await transportRun();
      let failed = await state(safeOrder);
      assert.equal(failed.intents[0].state, 'failed');
      assert.equal(
        failed.transportEffects[failed.intents[0].command_id],
        undefined,
      );
      const retry = await sendIntent(safeOrder, {
        action: 'retry',
        intentId: safe.id,
        expectedIntentVersion: Number(failed.intents[0].version),
      });
      assert.equal(retry.status, 202);
      await transportRun();
      failed = await state(safeOrder);
      assert.equal(
        failed.intents.find((/** @type {any} */ i) => i.id === retry.body.id)
          .state,
        'delivered',
      );
      report.scenarios.push(
        'safe pre-send failure produces zero provider effects; explicit retry delivers the same valid checkout once',
      );
      const unknownOrder = await seed();
      const unknown = await issue(unknownOrder);
      await fault(unknown.id, 'unknown');
      await transportRun();
      const uncertainSend = await state(unknownOrder);
      assert.equal(uncertainSend.intents[0].state, 'unknown');
      assert.equal(
        uncertainSend.transportEffects[uncertainSend.intents[0].command_id],
        1,
      );
      assert.equal(
        (
          await sendIntent(unknownOrder, {
            action: 'retry',
            intentId: unknown.id,
            expectedIntentVersion: Number(uncertainSend.intents[0].version),
          })
        ).status,
        409,
      );
      await transportRun();
      assert.equal(
        (await state(unknownOrder)).transportEffects[
          uncertainSend.intents[0].command_id
        ],
        1,
      );
      report.scenarios.push(
        'unknown provider outcome records one effect and forbids blind retry',
      );
      const ownerOrder = await seed();
      const owner = await issue(ownerOrder);
      await fault(owner.id, 'owner');
      await transportRun();
      const changed = await state(ownerOrder);
      assert.equal(changed.intents[0].state, 'blocked');
      assert.equal(
        changed.transportEffects[changed.intents[0].command_id],
        undefined,
      );
      report.scenarios.push(
        'owner changes after reservation; final preflight blocks the provider call',
      );
      const paidOrder = await seed();
      const paid = await issue(paidOrder);
      assert.equal((await notify(await pay(paid.chargeId))).status, 200);
      await transportRun();
      const paidBeforeSend = await state(paidOrder);
      assert.equal(paidBeforeSend.intents[0].state, 'blocked');
      assert.equal(
        paidBeforeSend.transportEffects[paidBeforeSend.intents[0].command_id],
        undefined,
      );
      report.scenarios.push(
        'payment before transport blocks queued send without losing the financial receipt',
      );
      const flagOrder = await seed();
      const flagIntent = await issue(flagOrder);
      await post(crmBase, '/__billing-development/send-enabled', {
        enabled: false,
      });
      const flagNewOrder = await seed();
      assert.equal(
        (await sendIntent(flagNewOrder, { action: 'issue', percent: 30 }))
          .status,
        503,
      );
      await transportRun();
      const disabled = await state(flagOrder);
      assert.equal(disabled.intents[0].state, 'blocked');
      assert.equal(
        disabled.transportEffects[disabled.intents[0].command_id],
        undefined,
      );
      assert.equal((await notify(await pay(flagIntent.chargeId))).status, 200);
      assert.equal(
        (await state(flagOrder)).view.billing.receivedAmountCents,
        3000,
      );
      await post(crmBase, '/__billing-development/send-enabled', {
        enabled: true,
      });
      report.scenarios.push(
        'send flag off blocks admissions/reservations while financial callbacks remain active',
      );
      const correctionOrder = await seed();
      const predecessor = await issue(correctionOrder);
      await post(crmBase, '/__billing-development/advance-clock', {
        hours: 25,
      });
      await post(crmBase, '/__billing-development/close-unpaid', {
        orderId: correctionOrder,
      });
      const corrected = await sendIntent(correctionOrder, {
        action: 'correct',
        chargeId: predecessor.chargeId,
        amountCents: 2500,
        confirmedAgreement: true,
        confirmedProviderReview: true,
      });
      assert.equal(corrected.status, 202);
      await post(crmBase, '/__billing-development/run-worker', {});
      await transportRun();
      await transportRun();
      const correction = await state(correctionOrder);
      assert.equal(
        correction.intents.find(
          (/** @type {any} */ i) => i.id === corrected.body.id,
        ).state,
        'delivered',
      );
      assert.equal(correction.view.billing.charges.length, 2);
      assert.equal((await notify(await pay(predecessor.chargeId))).status, 200);
      assert.equal(
        (await state(correctionOrder)).view.billing.reviewRequired,
        true,
      );
      report.scenarios.push(
        'expired reviewed predecessor is corrected and delivered; its late receipt remains visible in review',
      );
    }
    const logs = await docker(['logs', names.n8n]);
    const serviceLogs = await docker(['logs', names.service]);
    for (const content of [
      logs.stdout + logs.stderr,
      serviceLogs.stdout + serviceLogs.stderr,
    ]) {
      for (const secret of Object.values(DEVELOPMENT_CREDENTIALS))
        assert.equal(
          content.includes(secret),
          false,
          'credential value leaked in logs',
        );
      assert.equal(
        content.includes('https://checkout.infinitepay.io/synthetic-'),
        false,
        'checkout URL leaked in logs',
      );
      assert.equal(
        content.includes('https://receipt.infinitepay.io/synthetic-'),
        false,
        'receipt URL leaked in logs',
      );
    }
    report.scenarios.push(
      'n8n and CRM stdout/stderr contain no synthetic credential or checkout URL',
    );
    await writeFile(
      join(directory, 'report.json'),
      JSON.stringify({ ...report, verdict: 'PASS' }, null, 2) + '\n',
    );
    process.stdout.write(
      `PASS billing development: ${report.scenarios.length} scenarios; ${directory}\n`,
    );
    return report;
  } catch (error) {
    await writeFile(
      join(directory, 'report.json'),
      JSON.stringify(
        { ...report, verdict: 'FAIL', error: String(error) },
        null,
        2,
      ) + '\n',
    );
    for (const name of started) {
      const result = await docker(['logs', name]).catch(() => ({
        stdout: '',
        stderr: '',
      }));
      await writeFile(
        join(directory, `${name}.log`),
        result.stdout + result.stderr,
      );
    }
    throw error;
  } finally {
    try {
      await cleanup();
      const saved = JSON.parse(
        await readFile(join(directory, 'report.json'), 'utf8'),
      );
      await writeFile(
        join(directory, 'report.json'),
        JSON.stringify({ ...saved, resourcesRemoved: true }, null, 2) + '\n',
      );
    } catch (error) {
      await writeFile(
        join(directory, 'report.json'),
        JSON.stringify(
          {
            ...report,
            verdict: 'FAIL',
            resourcesRemoved: false,
            error: String(error),
          },
          null,
          2,
        ) + '\n',
      );
      throw error;
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  }

  /** @param {keyof typeof names} kind @param {string[]} args */
  async function run(kind, args) {
    const name = names[kind];
    if (interrupted) throw new Error('BILLING_DEVELOPMENT_INTERRUPTED');
    started.push(name);
    await docker([
      'run',
      '--detach',
      '--name',
      name,
      '--network',
      network,
      ...args,
    ]);
    if (interrupted) throw new Error('BILLING_DEVELOPMENT_INTERRUPTED');
  }
}

/** @param {string[]} args */
async function docker(args) {
  return execute('docker', args, {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180000,
  });
}
/** @param {()=>Promise<boolean>} check @param {()=>boolean} [isInterrupted] */
async function until(check, isInterrupted = () => false) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (isInterrupted()) throw new Error('BILLING_DEVELOPMENT_INTERRUPTED');
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('BILLING_DEVELOPMENT_STARTUP_TIMEOUT');
}
/** Requests remain inside the no-egress Docker network: no host listener or
 * published service port is necessary, even on Docker Desktop for Windows.
 * @param {string} container */
function dockerHttp(container) {
  return async (
    /** @type {string} */ base,
    /** @type {string} */ path,
    /** @type {any} */ body = undefined,
    requireSuccess = true,
    /** @type {Record<string,string>} */ headers = {},
  ) => {
    assert.ok(['http://billing-crm:3000', 'http://n8n:5678'].includes(base));
    assert.ok(path.startsWith('/') && !path.startsWith('//'));
    const input = JSON.stringify({ url: base + path, body, headers });
    const script = `const input=JSON.parse(process.argv[1]);const response=await fetch(input.url,{method:input.body===undefined?'GET':'POST',headers:{'content-type':'application/json',...input.headers},body:input.body===undefined?undefined:JSON.stringify(input.body),signal:AbortSignal.timeout(45000),redirect:'error'});const raw=await response.text();let body;try{body=JSON.parse(raw)}catch{body={response:raw.slice(0,120)}};process.stdout.write(JSON.stringify({status:response.status,body}));`;
    const result = await docker([
      'exec',
      container,
      'node',
      '--input-type=module',
      '-e',
      script,
      input,
    ]);
    const response = JSON.parse(result.stdout);
    if (requireSuccess)
      assert.ok(
        response.status >= 200 && response.status < 300,
        `local route ${path} returned ${response.status}: ${JSON.stringify(response.body)}`,
      );
    return response;
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runBillingDevelopmentSmoke({
    transport: process.argv.includes('--transport'),
  });
