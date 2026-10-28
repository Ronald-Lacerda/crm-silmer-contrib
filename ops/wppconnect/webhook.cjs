// WPP-01 / MSG-01..04. Retry inbound notifications, never outbound sends.
const transientCodes = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ECONNRESET',
  'EAI_AGAIN',
]);
const pn = (value) =>
  typeof value === 'string' &&
  /^\d{8,15}@(c\.us|s\.whatsapp\.net)$/.test(value);

async function deliverWebhook(
  client,
  req,
  event,
  data,
  transport,
  options = {},
) {
  const env = options.env || process.env;
  if (env.WPP_PHASE !== 'integrated' || !['onmessage', 'onack'].includes(event))
    return false;
  if (client?.session !== env.WPP_SESSION) return false;
  const configured = req.serverOptions.webhook;
  if (!configured?.url || configured.url !== env.WPP_WEBHOOK_URL) return false;
  if (client?.config?.webhook && client.config.webhook !== configured.url)
    return false;
  if (
    event === 'onmessage' &&
    (data?.fromMe !== false ||
      data?.isGroupMsg ||
      /@(g\.us|broadcast|newsletter)$/.test(data?.from || ''))
  )
    return false;
  let ownJid;
  try {
    ownJid = await client.getWid();
  } catch {}
  if (!pn(ownJid) || ownJid !== env.WPP_EXPECTED_OWN_JID) {
    process.stderr.write('WPP_IDENTITY_UNAVAILABLE\n');
    return false;
  }
  // Trusted fields overwrite payload fields. Timestamp and body are stable across retries.
  const body = {
    ...data,
    event,
    session: client.session,
    __wpp_received_at: (options.now || (() => new Date()))().toISOString(),
    __wpp_own_jid: ownJid,
  };
  const sleep =
    options.sleep ||
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await transport.post(configured.url, body, {
        timeout: 30000,
        maxRedirects: 0,
        headers: { 'X-Silmer-WPP-Token': env.WPP_WEBHOOK_TOKEN },
      });
      if (result.status < 200 || result.status >= 300) {
        const error = new Error('WPP_WEBHOOK_HTTP');
        error.response = { status: result.status };
        throw error;
      }
      return true;
    } catch (error) {
      const status = error?.response?.status;
      const retryable = Number.isInteger(status)
        ? status >= 500 && status <= 599
        : transientCodes.has(error?.code);
      if (!retryable || attempt === 2) {
        process.stderr.write('WPP_WEBHOOK_DELIVERY_FAILED\n');
        return false;
      }
      await sleep(5000 * 2 ** attempt);
    }
  }
  return false;
}

module.exports = { deliverWebhook };
