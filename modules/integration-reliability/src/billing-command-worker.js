export const BILLING_COMMAND_JOB_TYPE = 'billing.checkout.create';
export const BILLING_COMMAND_QUEUE = 'billing';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * The CRM reservation in the dedicated workflow is the financial effect fence.
 * A delivery timeout is still uncertain: never automatically emit another link.
 * Only bounded technical codes leave this boundary; upstream bodies are private.
 *
 * @param {{endpoint:string, clientId:string, clientSecret:string, allowInsecureLocal?:boolean,
 *   timeoutMs?:number, fetchImpl?: (url:URL, init:RequestInit)=>Promise<{status:number,json:()=>Promise<unknown>}>}} options
 */
export function createBillingCommandJobHandler(options) {
  const endpoint = new URL(options.endpoint);
  const local =
    options.allowInsecureLocal === true &&
    endpoint.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== 'https:' && !local) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new TypeError(
      'A private HTTPS billing workflow endpoint is required',
    );
  }
  if (
    typeof options.clientId !== 'string' ||
    !options.clientId.trim() ||
    /[:\r\n]/u.test(options.clientId) ||
    typeof options.clientSecret !== 'string' ||
    options.clientSecret.length < 32 ||
    /[\r\n]/u.test(options.clientSecret)
  ) {
    throw new TypeError('Valid billing workflow credentials are required');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Billing workflow timeout must be 1..60000 ms');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const authorization = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`;
  /**
   * @param {Readonly<Record<string,any>>} job
   * @param {{markEffectStarted:(input:{provider:string})=>Promise<boolean>}} context
   */
  return async function deliverBillingCommand(job, context) {
    if (
      job.jobType !== BILLING_COMMAND_JOB_TYPE ||
      typeof job.idempotencyKey !== 'string' ||
      !UUID.test(job.idempotencyKey)
    ) {
      return /** @type {const} */ ({
        outcome: 'failed',
        errorCode: 'BILLING_COMMAND_INVALID',
        retryable: false,
        retrySafe: false,
      });
    }
    let effectStarted = false;
    try {
      if (!(await context.markEffectStarted({ provider: 'n8n' }))) {
        return /** @type {const} */ ({
          outcome: 'failed',
          errorCode: 'BILLING_LEASE_LOST',
          retryable: false,
          retrySafe: false,
        });
      }
      effectStarted = true;
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': job.idempotencyKey,
          'x-correlation-id': job.idempotencyKey,
        },
        body: JSON.stringify({
          schema_version: '1.0',
          charge_id: job.idempotencyKey,
        }),
      });
      if ([401, 403].includes(response.status)) {
        return /** @type {const} */ ({
          outcome: 'failed',
          errorCode: 'BILLING_WORKFLOW_AUTH_REJECTED',
          retryable: false,
          retrySafe: false,
        });
      }
      if (response.status < 200 || response.status > 299) {
        throw new Error('BILLING_WORKFLOW_UNCERTAIN');
      }
      const acknowledgement = /** @type {any} */ (await response.json());
      if (
        !acknowledgement ||
        acknowledgement.accepted !== true ||
        Object.keys(acknowledgement).some(
          (key) => !['accepted', 'duplicate'].includes(key),
        )
      ) {
        throw new Error('BILLING_WORKFLOW_UNCERTAIN');
      }
      return /** @type {const} */ ({
        outcome: 'sent',
        providerExternalId: job.idempotencyKey,
      });
    } catch {
      return effectStarted
        ? /** @type {const} */ ({
            outcome: 'outcome_unknown',
            errorCode: 'BILLING_WORKFLOW_OUTCOME_UNKNOWN',
            retryable: false,
            retrySafe: false,
          })
        : /** @type {const} */ ({
            outcome: 'failed',
            errorCode: 'BILLING_WORKFLOW_NOT_STARTED',
            retryable: true,
            retrySafe: true,
          });
    }
  };
}
