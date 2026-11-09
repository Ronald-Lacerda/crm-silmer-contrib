import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createOrderBillingDevelopmentWorkflow } from '../ops/n8n/workflows/create-order-billing-workflow.mjs';
import { createOrderBillingCheckWorkflow } from '../ops/n8n/workflows/create-order-billing-check-workflow.mjs';
import { createBillingDevelopmentTransportWorkflow } from '../ops/n8n/workflows/create-order-billing-transport-dev-workflow.mjs';
import { DEVELOPMENT_CREDENTIALS } from './billing-development-service.mjs';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const directory = join(root, 'var', 'billing-development-interactive');
const composeArgs = [
  'compose',
  '--project-name',
  'crm-silmer-billing-dev',
  '--file',
  join(root, 'docker-compose.billing-dev.yml'),
];

/** Fixed project, targets and synthetic identities. No remote configuration is accepted.
 * @param {string[]} args */
export async function billingDevelopmentInteractive(args) {
  const [command, ...extra] = args;
  assert.ok(
    ['up', 'status', 'stop', 'reset'].includes(command),
    'Use up | status | stop | reset --confirm-synthetic-reset',
  );
  if (command === 'reset')
    assert.deepEqual(
      extra,
      ['--confirm-synthetic-reset'],
      'Reset deletes only this synthetic project; explicit flag required',
    );
  else
    assert.deepEqual(
      extra,
      [],
      'No alternate host, project or credential is accepted',
    );
  await mkdir(directory, { recursive: true });
  if (command === 'up') {
    await prepare();
    await execute(process.execPath, ['scripts/build.mjs'], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180000,
    });
    await docker([...composeArgs, 'up', '--detach']);
    for (let n = 0; n < 120; n++) {
      try {
        const response = await globalThis.fetch(
          'http://127.0.0.1:4180/__billing-development/health',
          { signal: AbortSignal.timeout(1500), redirect: 'error' },
        );
        const n8nReady = await globalThis.fetch(
          'http://127.0.0.1:5685/healthz',
          {
            signal: AbortSignal.timeout(1500),
            redirect: 'error',
          },
        );
        if (response.ok && n8nReady.ok) {
          const registered = await globalThis.fetch(
            'http://127.0.0.1:5685/webhook/silmer/order-billing-dev/create',
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization:
                  'Basic ' +
                  Buffer.from(
                    DEVELOPMENT_CREDENTIALS.workerUser +
                      ':' +
                      DEVELOPMENT_CREDENTIALS.workerPassword,
                  ).toString('base64'),
              },
              body: JSON.stringify({
                schema_version: '1.0',
                charge_id: 'invalid',
              }),
              signal: AbortSignal.timeout(5000),
              redirect: 'error',
            },
          );
          if (registered.status === 404) continue;
          await writeFile(
            join(directory, 'state.json'),
            JSON.stringify(
              {
                synthetic: true,
                project: 'crm-silmer-billing-dev',
                crmUrl: 'http://127.0.0.1:4180',
                toolsUrl: 'http://127.0.0.1:4180/__billing-development',
                n8nUrl: 'http://127.0.0.1:5685',
                readyAt: new Date().toISOString(),
              },
              null,
              2,
            ) + '\n',
          );
          process.stdout.write(
            'Billing DEV ready: http://127.0.0.1:4180; tools /__billing-development; n8n http://127.0.0.1:5685\n',
          );
          return;
        }
      } catch {}
      await new Promise((done) => setTimeout(done, 1000));
    }
    throw new Error(
      'BILLING_INTERACTIVE_STARTUP_TIMEOUT: inspect docker compose --project-name crm-silmer-billing-dev --file docker-compose.billing-dev.yml logs',
    );
  }
  if (command === 'status') {
    const result = await docker([...composeArgs, 'ps', '--format', 'json']);
    process.stdout.write(result.stdout);
    return;
  }
  await docker([
    ...composeArgs,
    'down',
    ...(command === 'reset' ? ['--volumes'] : []),
  ]);
  await writeFile(
    join(directory, 'state.json'),
    JSON.stringify(
      {
        synthetic: true,
        project: 'crm-silmer-billing-dev',
        running: false,
        reset: command === 'reset',
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(
    command === 'reset'
      ? 'Synthetic billing data reset.\n'
      : 'Billing DEV stopped; synthetic database preserved.\n',
  );
}

async function prepare() {
  const source = JSON.parse(
    await readFile(
      join(
        root,
        'ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      ),
      'utf8',
    ),
  );
  const workflows = /** @type {any[]} */ ([
    createOrderBillingDevelopmentWorkflow(),
    createBillingDevelopmentTransportWorkflow(source),
    createOrderBillingCheckWorkflow({}, { development: true }),
  ]);
  workflows[0].id = 'SyntheticBillingDev';
  workflows[2].id = 'SyntheticBillingCheckDev';
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
  for (const workflow of workflows)
    for (const node of workflow.nodes)
      for (const [kind, reference] of Object.entries(node.credentials ?? {})) {
        const credential = credentials.find(
          (candidate) => candidate.name === /** @type {any} */ (reference).name,
        );
        assert.ok(credential);
        node.credentials[kind] = { id: credential.id, name: credential.name };
      }
  await writeFile(
    join(directory, 'credentials.json'),
    JSON.stringify(credentials),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, 'workflows.json'),
    JSON.stringify(workflows),
    { mode: 0o600 },
  );
}

/** @param {string[]} args */
async function docker(args) {
  return execute('docker', args, {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180000,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await billingDevelopmentInteractive(process.argv.slice(2));
