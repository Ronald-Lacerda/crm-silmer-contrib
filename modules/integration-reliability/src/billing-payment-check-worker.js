export const BILLING_PAYMENT_CHECK_JOB_TYPE = 'billing.payment.check';

/** Consultations have no irreversible provider effect: bounded retries are safe.
 * @param {{endpoint:string,clientId:string,clientSecret:string,allowInsecureLocal?:boolean,timeoutMs?:number,fetchImpl?:any}} options */
export function createBillingPaymentCheckJobHandler(options) {
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
  )
    throw new TypeError('A private HTTPS billing check endpoint is required');
  if (
    typeof options.clientId !== 'string' ||
    !options.clientId.trim() ||
    /[:\r\n]/u.test(options.clientId) ||
    typeof options.clientSecret !== 'string' ||
    options.clientSecret.length < 32 ||
    /[\r\n]/u.test(options.clientSecret)
  )
    throw new TypeError('Valid billing workflow credentials are required');
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new TypeError('Billing check timeout must be 1..60000 ms');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return async (/** @type {any} */ job) => {
    const checkId = String(job.idempotencyKey ?? '').split(':')[0];
    if (
      job.jobType !== BILLING_PAYMENT_CHECK_JOB_TYPE ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        checkId,
      )
    )
      return {
        outcome: /** @type {const} */ ('failed'),
        errorCode: 'BILLING_CHECK_INVALID',
        retryable: false,
        retrySafe: false,
      };
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`,
          'content-type': 'application/json',
          'idempotency-key': job.idempotencyKey,
          'x-correlation-id': checkId,
        },
        body: JSON.stringify({ schema_version: '1.0', check_id: checkId }),
      });
      if ([401, 403].includes(response.status))
        return {
          outcome: /** @type {const} */ ('failed'),
          errorCode: 'BILLING_CHECK_AUTH_REJECTED',
          retryable: false,
          retrySafe: false,
        };
      if (
        response.status < 200 ||
        response.status > 299 ||
        (await response.json())?.accepted !== true
      )
        throw new Error('BILLING_CHECK_FAILED');
      return {
        outcome: /** @type {const} */ ('sent'),
        providerExternalId: checkId,
      };
    } catch {
      return {
        outcome: /** @type {const} */ ('failed'),
        errorCode: 'BILLING_CHECK_UNAVAILABLE',
        retryable: true,
        retrySafe: true,
      };
    }
  };
}

/** Enqueue known candidates only. Existing queue attempts bound transport retries.
 * @param {any} database @param {Date} [now] */
export async function scheduleBillingPaymentChecks(database, now = new Date()) {
  return database.transaction(async (/** @type {any} */ client) => {
    const due = (
      await client.query(
        `SELECT * FROM crm.order_billing_payment_checks WHERE status='not_paid' AND next_check_at<=$1 AND attempts<6 ORDER BY next_check_at,id FOR UPDATE SKIP LOCKED LIMIT 20`,
        [now],
      )
    ).rows;
    for (const check of due) {
      const attempt = Number(check.attempts) + 1;
      await client.query(
        `INSERT INTO crm.outbox_jobs(id,job_type,idempotency_key,status,priority,available_at,created_at,queue,attempt_count,max_attempts,updated_at,effect_policy)
        VALUES($1,'billing.payment.check',$2,'pending',90,$3,$3,'billing',0,3,$3,'queryable')`,
        [`billing-check:${check.id}:${attempt}`, `${check.id}:${attempt}`, now],
      );
      await client.query(
        `UPDATE crm.order_billing_payment_checks SET status='queued',attempts=$2,next_check_at=NULL WHERE id=$1`,
        [check.id, attempt],
      );
    }
    return due.length;
  });
}
