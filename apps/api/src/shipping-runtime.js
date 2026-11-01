import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import { authorize } from '@crm-silmer/identity-access';
import {
  MELHOR_ENVIO_BASE_URLS,
  MelhorEnvioError,
  buildAuthorizeUrl,
  buildQuoteRequest,
  createMelhorEnvioClient,
  exchangeAuthorizationCode,
  isTokenExpiring,
  refreshAccessToken,
} from '@crm-silmer/shipping';

export const SHIPPING_SCOPES = Object.freeze([
  'shipping-calculate',
  'shipping-companies',
]);

export class ShippingHttpError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** @param {string} value */
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** @param {Record<string,string|undefined>} env */
function configuration(env) {
  const environment = env.MELHOR_ENVIO_ENVIRONMENT ?? 'sandbox';
  const key = Buffer.from(env.MELHOR_ENVIO_ENVELOPE_KEY ?? '', 'base64');
  const clientId = env.MELHOR_ENVIO_CLIENT_ID ?? '';
  const clientSecret = env.MELHOR_ENVIO_CLIENT_SECRET ?? '';
  const redirectUri = env.MELHOR_ENVIO_REDIRECT_URI ?? '';
  const userAgent = env.MELHOR_ENVIO_USER_AGENT ?? '';
  let validRedirect = false;
  try {
    const parsed = new URL(redirectUri);
    validRedirect =
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname === '/melhor-envio';
  } catch {
    /* Incomplete configuration stays disabled. */
  }
  const validText = [clientId, clientSecret, userAgent].every(
    (value) =>
      value.length > 0 && value.length <= 4096 && !/[\r\n]/u.test(value),
  );
  const configured =
    env.MELHOR_ENVIO_ENABLED === 'true' &&
    ['sandbox', 'production'].includes(environment) &&
    key.length === 32 &&
    validRedirect &&
    validText &&
    /[^\s@]+@[^\s@]+\.[^\s@]+/u.test(userAgent);
  return {
    configured,
    environment: environment === 'production' ? 'production' : 'sandbox',
    baseUrl:
      environment === 'production'
        ? MELHOR_ENVIO_BASE_URLS.production
        : MELHOR_ENVIO_BASE_URLS.sandbox,
    key,
    clientId,
    clientSecret,
    redirectUri,
    userAgent,
    contextKey: hash(JSON.stringify([environment, clientId, redirectUri])),
  };
}

/** T138: credentials are bound to this configured app/environment by AEAD.
 * @param {any} tokens @param {Buffer} key @param {string} contextKey */
function encrypt(tokens, key, contextKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`shipping:${contextKey}:1`));
  const bytes = Buffer.concat([
    cipher.update(
      JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      }),
    ),
    cipher.final(),
  ]);
  return {
    algorithm: 'AES-256-GCM',
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: bytes.toString('base64'),
  };
}

/** @param {any} envelope @param {Buffer} key @param {string} contextKey */
function decrypt(envelope, key, contextKey) {
  try {
    if (envelope?.algorithm !== 'AES-256-GCM' || envelope.version !== 1)
      throw new Error();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(`shipping:${contextKey}:1`));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const value = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    );
    if (
      typeof value.accessToken !== 'string' ||
      !value.accessToken ||
      typeof value.refreshToken !== 'string' ||
      !value.refreshToken
    )
      throw new Error();
    return value;
  } catch {
    throw new ShippingHttpError(409, 'MELHOR_ENVIO_RECONNECT_REQUIRED');
  }
}

/** Recheck the current user under locks before handling credentials.
 * @param {any} client @param {any} supplied */
async function lockActor(client, supplied) {
  const { rows } = await client.query(
    `SELECT u.id, f.function_name FROM crm.users u JOIN crm.user_functions f ON f.user_id=u.id WHERE u.id=$1 AND u.disabled_at IS NULL FOR SHARE OF u,f`,
    [supplied?.id],
  );
  if (!rows[0]) throw new ShippingHttpError(403, 'FORBIDDEN');
  const grants = await client.query(
    'SELECT capability FROM crm.user_capabilities WHERE user_id=$1 FOR SHARE',
    [supplied.id],
  );
  const actor = {
    id: supplied.id,
    kind: /** @type {const} */ ('human'),
    functionName: rows[0].function_name,
    capabilities: grants.rows.map((/** @type {any} */ row) => row.capability),
  };
  authorize(actor, 'shipping.manage');
  return actor;
}

/** @param {any} input */
function requireBinding(input) {
  if (
    typeof input.sessionBinding !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input.sessionBinding)
  )
    throw new ShippingHttpError(403, 'FORBIDDEN');
}

/** @param {unknown} input */
export function quotePayload(input) {
  const body = /** @type {any} */ (input);
  const fields = [
    'fromPostalCode',
    'toPostalCode',
    'weightGrams',
    'widthCm',
    'heightCm',
    'lengthCm',
    'insuranceValueCents',
  ];
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !fields.includes(key)) ||
    fields.some((key) => !(key in body))
  )
    throw new ShippingHttpError(400, 'INVALID_REQUEST');
  for (const key of [
    'weightGrams',
    'widthCm',
    'heightCm',
    'lengthCm',
    'insuranceValueCents',
  ]) {
    const max =
      key === 'weightGrams'
        ? 1_000_000
        : key === 'insuranceValueCents'
          ? 100_000_000
          : 1_000;
    if (
      !Number.isSafeInteger(body[key]) ||
      body[key] < (key === 'insuranceValueCents' ? 0 : 1) ||
      body[key] > max
    )
      throw new ShippingHttpError(422, 'INVALID_QUOTE_PACKAGES');
  }
  return buildQuoteRequest({
    fromPostalCode: body.fromPostalCode,
    toPostalCode: body.toPostalCode,
    packages: [
      {
        weightGrams: body.weightGrams,
        widthCm: body.widthCm,
        heightCm: body.heightCm,
        lengthCm: body.lengthCm,
        insuranceCents: body.insuranceValueCents,
      },
    ],
  });
}

/** @param {unknown} input */
export function quoteProjection(input) {
  if (!Array.isArray(input) || input.length > 100)
    throw new MelhorEnvioError('invalid_response');
  /** @type {Array<{id:number,name:string,company:string,priceCents:number,deliveryDays:number}>} */
  const services = [];
  /** @type {Array<{id:number,name:string,message:string}>} */
  const unavailable = [];
  for (const row of input) {
    if (
      !row ||
      !Number.isSafeInteger(row.id) ||
      row.id < 1 ||
      typeof row.name !== 'string' ||
      row.name.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(row.name)
    )
      throw new MelhorEnvioError('invalid_response');
    if (row.error) {
      unavailable.push({
        id: row.id,
        name: row.name,
        message: 'Serviço indisponível para esta cotação.',
      });
      continue;
    }
    const price = String(row.custom_price ?? row.price ?? '');
    const days = row.custom_delivery_time ?? row.delivery_time;
    if (
      !/^\d{1,7}(?:\.\d{1,2})?$/u.test(price) ||
      !Number.isSafeInteger(days) ||
      days < 0 ||
      days > 365 ||
      typeof row.company?.name !== 'string' ||
      row.company.name.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(row.company.name)
    )
      throw new MelhorEnvioError('invalid_response');
    services.push({
      id: row.id,
      name: row.name,
      company: row.company.name,
      priceCents: Math.round(Number(price) * 100),
      deliveryDays: days,
    });
  }
  return { services, unavailable };
}

/** @param {any} database @param {{access:any,environment?:Record<string,string|undefined>,clock?:()=>Date,fetch?:any,timeoutMs?:number}} options */
export function createShippingApiRuntime(database, options) {
  const config = configuration(options.environment ?? process.env);
  const clock = options.clock ?? (() => new Date());
  const oauth = {
    baseUrl: config.baseUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    userAgent: config.userAgent,
    fetch: options.fetch,
    now: clock,
    timeoutMs: options.timeoutMs,
  };
  const requireConfigured = () => {
    if (!config.configured)
      throw new ShippingHttpError(503, 'MELHOR_ENVIO_NOT_CONFIGURED');
  };

  /** @param {any} row */
  function statusOf(row) {
    const stalledRefresh =
      row?.refresh_started_at &&
      clock().getTime() - new Date(row.refresh_started_at).getTime() >= 60_000;
    return {
      configured: config.configured,
      connected:
        Boolean(row?.token_envelope) &&
        !row?.reconnect_required &&
        !stalledRefresh,
      environment: config.environment,
      expiresAt: row?.expires_at
        ? new Date(row.expires_at).toISOString()
        : null,
      reconnectRequired: Boolean(row?.reconnect_required || stalledRefresh),
    };
  }
  /** All replicas share this transaction lock; remote refresh is never concurrent.
   * @param {any} client */
  async function lockConnection(client) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `shipping:${config.contextKey}`,
    ]);
    await client.query(
      'INSERT INTO crm.shipping_connections (context_key,environment) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [config.contextKey, config.environment],
    );
    const { rows } = await client.query(
      'SELECT * FROM crm.shipping_connections WHERE context_key=$1 FOR UPDATE',
      [config.contextKey],
    );
    return rows[0];
  }
  /** @param {any} client @param {any} tokens @param {any} input @param {string} reason */
  async function save(client, tokens, input, reason) {
    const { rows } = await client.query(
      `UPDATE crm.shipping_connections SET token_envelope=$2::jsonb,expires_at=$3,reconnect_required=false,refresh_started_at=NULL,version=version+1,connected_by=$4,updated_at=$5 WHERE context_key=$1 RETURNING *`,
      [
        config.contextKey,
        JSON.stringify(encrypt(tokens, config.key, config.contextKey)),
        tokens.expiresAt,
        input.actor.id,
        clock(),
      ],
    );
    await audit(client, input, rows[0].version, reason);
    return rows[0];
  }
  /** @param {any} client @param {any} input @param {number|string} version @param {string} reason */
  async function audit(client, input, version, reason) {
    await new PostgresAuditTrail(client, { clock }).append({
      actor: input.actor.id,
      action: 'shipping.connection',
      target: { type: 'shipping-connection', id: config.contextKey },
      version,
      reason,
      correlationId: input.correlationId,
    });
  }
  /** @param {any} client @param {any} input */
  async function reconnect(client, input) {
    const { rows } = await client.query(
      'UPDATE crm.shipping_connections SET reconnect_required=true,refresh_started_at=NULL,version=version+1,updated_at=$2 WHERE context_key=$1 RETURNING *',
      [config.contextKey, clock()],
    );
    await audit(client, input, rows[0].version, 'SHIPPING_RECONNECT_REQUIRED');
  }
  /** Return an error marker so token failure metadata commits before throwing.
   * @param {any} input */
  async function accessToken(input) {
    const result = await database.transaction(
      async (/** @type {any} */ client) => {
        await lockActor(client, input.actor);
        const row = await lockConnection(client);
        if (row.reconnect_required)
          throw new ShippingHttpError(409, 'MELHOR_ENVIO_RECONNECT_REQUIRED');
        if (!row.token_envelope)
          throw new ShippingHttpError(409, 'MELHOR_ENVIO_NOT_CONNECTED');
        if (row.refresh_started_at) {
          if (
            clock().getTime() - new Date(row.refresh_started_at).getTime() <
            60_000
          )
            throw new ShippingHttpError(
              503,
              'MELHOR_ENVIO_REFRESH_IN_PROGRESS',
            );
          await reconnect(client, input);
          return {
            error: new ShippingHttpError(
              409,
              'MELHOR_ENVIO_RECONNECT_REQUIRED',
            ),
          };
        }
        let tokens;
        try {
          tokens = decrypt(row.token_envelope, config.key, config.contextKey);
        } catch (error) {
          await reconnect(client, input);
          return { error };
        }
        if (!isTokenExpiring({ expiresAt: row.expires_at, now: clock }))
          return { token: tokens.accessToken, version: row.version };
        // Commit this claim before calling OAuth: a crash or a failed save
        // cannot expose the old refresh token to an automatic second attempt.
        const claimed = await client.query(
          'UPDATE crm.shipping_connections SET refresh_started_at=$2,version=version+1,updated_at=$2 WHERE context_key=$1 RETURNING *',
          [config.contextKey, clock()],
        );
        await audit(
          client,
          input,
          claimed.rows[0].version,
          'SHIPPING_REFRESH_STARTED',
        );
        return {
          refreshToken: tokens.refreshToken,
          version: claimed.rows[0].version,
        };
      },
    );
    if (result.error) throw result.error;
    if (result.token) return result;
    let renewed;
    try {
      renewed = await refreshAccessToken({
        ...oauth,
        refreshToken: result.refreshToken,
      });
    } catch (error) {
      await database.transaction(async (/** @type {any} */ client) => {
        await lockActor(client, input.actor);
        const row = await lockConnection(client);
        if (
          Number(row.version) === Number(result.version) &&
          row.refresh_started_at
        )
          await reconnect(client, input);
      });
      throw error;
    }
    return database.transaction(async (/** @type {any} */ client) => {
      await lockActor(client, input.actor);
      const row = await lockConnection(client);
      if (
        Number(row.version) !== Number(result.version) ||
        !row.refresh_started_at
      )
        throw new ShippingHttpError(409, 'MELHOR_ENVIO_CONNECTION_CHANGED');
      const saved = await save(
        client,
        renewed,
        input,
        'SHIPPING_TOKEN_REFRESHED',
      );
      return { token: renewed.accessToken, version: saved.version };
    });
  }
  return Object.freeze({
    /** @param {any} input */
    authorizeRead: (input) => options.access.authorizeRead(input),
    /** @param {any} input */
    authorizeWrite: (input) => options.access.authorizeWrite(input),
    /** @param {any} input */
    async status(input) {
      if (!config.configured) return statusOf(null);
      return database.transaction(async (/** @type {any} */ client) => {
        await lockActor(client, input.actor);
        const { rows } = await client.query(
          'SELECT * FROM crm.shipping_connections WHERE context_key=$1',
          [config.contextKey],
        );
        return statusOf(rows[0]);
      });
    },
    /** @param {any} input */
    async authorize(input) {
      requireConfigured();
      requireBinding(input);
      const state = randomBytes(32).toString('base64url');
      await database.transaction(async (/** @type {any} */ client) => {
        await lockActor(client, input.actor);
        const connection = await lockConnection(client);
        await client.query(
          'DELETE FROM crm.shipping_oauth_states WHERE expires_at <= $1',
          [clock()],
        );
        await client.query(
          `INSERT INTO crm.shipping_oauth_states (context_key,actor_id,session_hash,state_hash,expires_at,connection_version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (context_key,actor_id,session_hash) DO UPDATE SET state_hash=excluded.state_hash,expires_at=excluded.expires_at,connection_version=excluded.connection_version`,
          [
            config.contextKey,
            input.actor.id,
            input.sessionBinding,
            hash(state),
            new Date(clock().getTime() + 600_000),
            connection.version,
          ],
        );
      });
      return {
        authorizationUrl: buildAuthorizeUrl({
          ...oauth,
          state,
          scopes: SHIPPING_SCOPES,
        }),
      };
    },
    /** @param {any} input */
    async complete(input) {
      requireConfigured();
      requireBinding(input);
      if (
        typeof input.state !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/u.test(input.state) ||
        typeof input.code !== 'string' ||
        !input.code ||
        input.code.length > 4096 ||
        /[\u0000-\u0020\u007f]/u.test(input.code)
      )
        throw new ShippingHttpError(400, 'INVALID_REQUEST');
      // Consume before the remote request in its own committed transaction.
      const claimedVersion = await database.transaction(
        async (/** @type {any} */ client) => {
          await lockActor(client, input.actor);
          const { rows } = await client.query(
            'DELETE FROM crm.shipping_oauth_states WHERE context_key=$1 AND actor_id=$2 AND session_hash=$3 AND state_hash=$4 AND expires_at>$5 RETURNING connection_version',
            [
              config.contextKey,
              input.actor.id,
              input.sessionBinding,
              hash(input.state),
              clock(),
            ],
          );
          if (!rows.length)
            throw new ShippingHttpError(409, 'MELHOR_ENVIO_INVALID_STATE');
          return rows[0].connection_version;
        },
      );
      return database.transaction(async (/** @type {any} */ client) => {
        await lockActor(client, input.actor);
        const connection = await lockConnection(client);
        if (Number(connection.version) !== Number(claimedVersion))
          throw new ShippingHttpError(409, 'MELHOR_ENVIO_CONNECTION_CHANGED');
        const tokens = await exchangeAuthorizationCode({
          ...oauth,
          code: input.code,
        });
        return statusOf(
          await save(client, tokens, input, 'SHIPPING_CONNECTED'),
        );
      });
    },
    /** @param {any} input */
    async quote(input) {
      requireConfigured();
      const body = quotePayload(input.body);
      const credentials = await accessToken(input);
      try {
        const client = createMelhorEnvioClient({
          ...oauth,
          getAccessToken: () => credentials.token,
        });
        return quoteProjection(await client.calculate(body));
      } catch (error) {
        if (error instanceof MelhorEnvioError && error.kind === 'auth') {
          await database.transaction(async (/** @type {any} */ client) => {
            await lockActor(client, input.actor);
            const row = await lockConnection(client);
            if (Number(row.version) === Number(credentials.version))
              await reconnect(client, input);
          });
        }
        throw error;
      }
    },
    /** @param {any} input */
    async disconnect(input) {
      requireConfigured();
      return database.transaction(async (/** @type {any} */ client) => {
        await lockActor(client, input.actor);
        await lockConnection(client);
        await client.query(
          'DELETE FROM crm.shipping_oauth_states WHERE context_key=$1',
          [config.contextKey],
        );
        const { rows } = await client.query(
          'UPDATE crm.shipping_connections SET token_envelope=NULL,expires_at=NULL,reconnect_required=false,refresh_started_at=NULL,version=version+1,updated_at=$2 WHERE context_key=$1 RETURNING *',
          [config.contextKey, clock()],
        );
        await audit(client, input, rows[0].version, 'SHIPPING_DISCONNECTED');
        return statusOf(rows[0]);
      });
    },
  });
}
