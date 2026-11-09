import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createOrderBillingDevelopmentWorkflow } from './create-order-billing-workflow.mjs';

export { createOrderBillingDevelopmentWorkflow };

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const destination = process.argv[2];
  if (!destination || !destination.endsWith('.json'))
    throw new Error(
      'Usage: node create-order-billing-dev-workflow.mjs <destination.json> [local-config.json]',
    );
  const configuration = process.argv[3]
    ? JSON.parse(await readFile(process.argv[3], 'utf8'))
    : {};
  await writeFile(
    destination,
    JSON.stringify(
      createOrderBillingDevelopmentWorkflow(configuration),
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(
    'Inactive synthetic billing workflow written. Use local DEV credentials only; checkout and receipt URLs are fixtures and must not be visited.',
  );
}
