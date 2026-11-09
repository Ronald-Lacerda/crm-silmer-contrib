import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { OlistError, integer, text } from './errors.js';
import { seal, open } from './crypto.js';
import {
  EMPTY_OLIST_SETTINGS,
  normalizeDocument,
  olistSettings,
  OLIST_AUTH,
  OLIST_API,
  OLIST_TOKEN,
} from './configuration.js';
import { olistJson } from './transport.js';
import { createOlistQuota, OLIST_READ_WAIT } from './quota.js';
import { lockOlistActor } from './access.js';
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');
/** `sleep`/`random` are injection points for the quota wait of `verifyAccount`.
 * @param {any} database @param {{config:ReturnType<typeof import('./configuration.js').olistConfiguration>,fetch?:typeof fetch,clock?:()=>Date,timeoutMs?:number,sleep?:(ms:number)=>Promise<unknown>,random?:()=>number}} options */
export function createOlistConnection(database, options) {
  const config = options.config;
  const clock = options.clock ?? (() => new Date());
  const quota = config.configured
    ? createOlistQuota(database, config.accountKey)
    : null;
  /** @param {any} input @param {(client:any)=>Promise<any>} work */
  const transaction = (input, work) =>
    input.transaction ? work(input.transaction) : database.transaction(work);
  const requireConfigured = () => {
    if (!config.configured) throw new OlistError('OLIST_NOT_CONFIGURED', 503);
  };
  /** @param {any} client */
  async function lockConnection(client) {
    await client.query(
      'INSERT INTO crm.olist_accounts(account_key) VALUES($1) ON CONFLICT DO NOTHING',
      [config.accountKey],
    );
    await client.query(
      'INSERT INTO crm.olist_settings(account_key) VALUES($1) ON CONFLICT DO NOTHING',
      [config.accountKey],
    );
    await client.query(
      'INSERT INTO crm.olist_connections(context_key,account_key) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [config.contextKey, config.accountKey],
    );
    const { rows } = await client.query(
      'SELECT * FROM crm.olist_connections WHERE context_key=$1 FOR UPDATE',
      [config.contextKey],
    );
    return rows[0];
  }
  /** Fixed codes only; caller free-text reasons are not copied to audit.
   * @param {any} client @param {any} input @param {string} code @param {number} version */
  async function event(client, input, code, version) {
    await client.query(
      'INSERT INTO crm.olist_events(id,account_key,actor_id,event_code,version,correlation_id) VALUES($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        config.accountKey,
        input.actor.id,
        code,
        version,
        text(input.correlationId, 128),
      ],
    );
    await client.query(
      "INSERT INTO crm.audit_events(id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at) VALUES($1,$2,'olist.connection','olist-account',$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        input.actor.id,
        config.accountKey,
        String(version),
        code,
        input.correlationId,
        clock(),
      ],
    );
  }
  /** @param {any} row @param {any} settings @param {any} [account] */
  function statusOf(row, settings, account) {
    const stalled = Boolean(
      row?.refresh_started_at &&
      clock().getTime() - new Date(row.refresh_started_at).getTime() >= 60_000,
    );
    return {
      configured: config.configured,
      connected:
        Boolean(row?.token_envelope) && !row?.reconnect_required && !stalled,
      reconnectRequired: Boolean(row?.reconnect_required || stalled),
      environment: 'production',
      version: Number(row?.version ?? 0),
      generation: Number(row?.generation ?? 0),
      expiresAt: row?.expires_at
        ? new Date(row.expires_at).toISOString()
        : null,
      accountConfigured: Boolean(config.expectedDocument),
      // Administrative switch is independent of transient token availability.
      creationActive: account?.creation_enabled === true,
      creationEnabled: Boolean(
        config.configured &&
        config.pilotUserIds.length &&
        account?.creation_enabled &&
        !account?.recovery_required &&
        row?.token_envelope &&
        !row?.exchange_nonce &&
        !row?.reconnect_required &&
        !stalled,
      ),
      recoveryRequired: account?.recovery_required !== false,
      pilotConfigured: config.pilotUserIds.length > 0,
      settingsVersion: Number(settings?.version ?? 0),
      settings: settings?.settings_envelope
        ? open(
            settings.settings_envelope,
            config.envelopeKey,
            'settings',
            config.accountKey,
            'central',
          )
        : { ...EMPTY_OLIST_SETTINGS },
    };
  }
  /** @param {any} client @param {any} row */
  async function projection(client, row) {
    const { rows } = await client.query(
      'SELECT * FROM crm.olist_settings WHERE account_key=$1',
      [config.accountKey],
    );
    const account = await client.query(
      'SELECT creation_enabled,recovery_required FROM crm.olist_accounts WHERE account_key=$1',
      [config.accountKey],
    );
    return statusOf(row, rows[0], account.rows[0]);
  }
  /** @param {any} client @param {any} input @param {any} row @param {string} code */
  async function invalidate(client, input, row, code) {
    const { rows } = await client.query(
      'UPDATE crm.olist_connections SET token_envelope=NULL,expires_at=NULL,refresh_expires_at=NULL,reconnect_required=true,refresh_nonce=NULL,refresh_started_at=NULL,exchange_nonce=NULL,version=version+1,generation=generation+1,updated_at=$2 WHERE context_key=$1 RETURNING *',
      [config.contextKey, clock()],
    );
    await event(client, input, code, Number(rows[0].version));
    return rows[0];
  }
  /** @param {URLSearchParams} form @param {Date|null} [previousRefreshExpiry] */
  async function tokens(form, previousRefreshExpiry = null) {
    const { body } = await olistJson(OLIST_TOKEN, {
      method: 'POST',
      form,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      maxBytes: 32_768,
    });
    if (
      typeof body?.access_token !== 'string' ||
      !body.access_token ||
      body.access_token.length > 16384 ||
      /[\u0000-\u0020\u007f]/u.test(body.access_token) ||
      typeof body?.refresh_token !== 'string' ||
      !body.refresh_token ||
      body.refresh_token.length > 16384 ||
      /[\u0000-\u0020\u007f]/u.test(body.refresh_token) ||
      !Number.isSafeInteger(body.expires_in) ||
      body.expires_in < 1 ||
      body.expires_in > 86400 ||
      (body.refresh_expires_in !== undefined &&
        (!Number.isSafeInteger(body.refresh_expires_in) ||
          body.refresh_expires_in < 1 ||
          body.refresh_expires_in > 2_592_000))
    )
      throw new OlistError('OLIST_INVALID_RESPONSE', 502);
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(clock().getTime() + body.expires_in * 1000),
      refreshExpiresAt: body.refresh_expires_in
        ? new Date(clock().getTime() + body.refresh_expires_in * 1000)
        : previousRefreshExpiry,
    };
  }
  /** @param {string} accessToken */
  async function verifyAccount(accessToken) {
    // The new token already exists (and the old refresh token may be spent), so
    // a momentarily exhausted shared quota must not invalidate the connection:
    // wait for a unit, bounded below the 60 s abandoned-refresh limit (15 s wait
    // + one 15 s request stays well under it). Only a wait that cannot fit
    // fails, and then the caller still reconnects.
    await quota?.reserveRead({
      ...OLIST_READ_WAIT.verify,
      sleep: options.sleep,
      random: options.random,
    });
    try {
      const { body, headers } = await olistJson(OLIST_API + '/info', {
        token: accessToken,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      });
      await quota?.observe(headers);
      if (normalizeDocument(body?.cpfCnpj) !== config.expectedDocument)
        throw new OlistError('OLIST_ACCOUNT_MISMATCH');
    } catch (error) {
      if (error instanceof OlistError && error.code === 'OLIST_RATE_LIMITED')
        await quota?.block(/** @type {any} */ (error).retryAfterMs);
      throw error;
    }
  }
  /** No SQL transaction spans token exchange or API calls.
   * @param {any} input @param {any} claim @param {string} action @param {()=>Promise<any>} exchange @param {boolean} refresh */
  async function finishToken(input, claim, action, exchange, refresh) {
    let renewed;
    try {
      renewed = await exchange();
      await verifyAccount(renewed.accessToken);
    } catch (error) {
      await database.transaction(async (/** @type {any} */ client) => {
        // Finalize failure metadata even when the originating actor was revoked;
        // no token or capability is installed by this recovery-only branch.
        const row = await lockConnection(client);
        if (
          Number(row.version) === claim.version &&
          (refresh ? row.refresh_nonce : row.exchange_nonce) === claim.nonce
        )
          await invalidate(client, input, row, 'OLIST_RECONNECT_REQUIRED');
      });
      throw error;
    }
    return transaction(input, async (/** @type {any} */ client) => {
      try {
        await lockOlistActor(client, input, action, clock());
      } catch {
        const row = await lockConnection(client);
        if (
          Number(row.version) === claim.version &&
          (refresh ? row.refresh_nonce : row.exchange_nonce) === claim.nonce
        )
          await invalidate(client, input, row, 'OLIST_AUTHORIZATION_CHANGED');
        return { error: new OlistError('FORBIDDEN', 403) };
      }
      const row = await lockConnection(client);
      if (
        Number(row.version) !== claim.version ||
        (refresh ? row.refresh_nonce : row.exchange_nonce) !== claim.nonce
      )
        return { error: new OlistError('OLIST_CONNECTION_CHANGED') };
      const { rows } = await client.query(
        'UPDATE crm.olist_connections SET token_envelope=$2::jsonb,expires_at=$3,refresh_expires_at=$4,reconnect_required=false,refresh_nonce=NULL,refresh_started_at=NULL,exchange_nonce=NULL,version=version+1,connected_by=$5,updated_at=$6 WHERE context_key=$1 RETURNING *',
        [
          config.contextKey,
          JSON.stringify(
            seal(
              {
                accessToken: renewed.accessToken,
                refreshToken: renewed.refreshToken,
              },
              config.envelopeKey,
              'tokens',
              config.accountKey,
              config.contextKey,
            ),
          ),
          renewed.expiresAt,
          renewed.refreshExpiresAt,
          input.actor.id,
          clock(),
        ],
      );
      await event(
        client,
        input,
        refresh ? 'OLIST_TOKEN_REFRESHED' : 'OLIST_CONNECTED',
        Number(rows[0].version),
      );
      return {
        token: renewed.accessToken,
        version: Number(rows[0].version),
        status: await projection(client, rows[0]),
      };
    });
  }
  /** @param {any} input */
  async function status(input) {
    return transaction(input, async (/** @type {any} */ client) => {
      await lockOlistActor(client, input, 'olist.manage', clock());
      if (!config.configured) return statusOf(null, null);
      const { rows } = await client.query(
        'SELECT * FROM crm.olist_connections WHERE context_key=$1',
        [config.contextKey],
      );
      return projection(client, rows[0]);
    });
  }
  return Object.freeze({
    quota,
    status,
    /** Human attestation of the external recovery procedure, never its proof.
     * No remote call, switch activation, deletion or retry is performed.
     * @param {any} input */
    async recovery(input) {
      requireConfigured();
      integer(input.expectedVersion, true);
      text(input.reason, 500);
      if (input.confirmed !== true)
        throw new OlistError('INVALID_REQUEST', 400);
      return transaction(input, async (/** @type {any} */ client) => {
        await lockOlistActor(client, input, 'olist.manage', clock());
        const row = await lockConnection(client);
        const account = (
          await client.query(
            'SELECT * FROM crm.olist_accounts WHERE account_key=$1 FOR UPDATE',
            [config.accountKey],
          )
        ).rows[0];
        if (Number(row.version) !== input.expectedVersion)
          throw new OlistError('VERSION_CONFLICT');
        if (account.creation_enabled || row.refresh_nonce || row.exchange_nonce)
          throw new OlistError('OLIST_RECOVERY_BLOCKED');
        // The exclusive account/connection fence prevents a new effect ticket
        // while the known local journal is checked. It cannot observe effects
        // absent from a restored backup: that remains the human attestation.
        // Completed reconciliation confirms the target, while an already
        // uncertain attempt remains immutable history. Only that current proof
        // (and a matching observed ID/number) resolves its historical error;
        // a reserved ticket still denotes an effect in flight and always blocks.
        // Variation POSTs may observe the parent ID: after reconciliation the
        // child ID differs. Accept only that child's own confirmed same-account
        // product parent, exactly as the read-only reconciler does.
        const evidence = (
          await client.query(
            `SELECT
          EXISTS(SELECT 1 FROM crm.olist_exports WHERE account_key=$1 AND
            (state IN ('queued','resolving','ready','reserved','uncertain') OR
             (last_error_code ~ '(DIVERGENT|READBACK_MISMATCH|RECONCILIATION_REQUIRED|UNCERTAIN)'
              AND state<>'invalidated' AND NOT (state IN ('confirmed','linked') AND remote_id IS NOT NULL)))) OR
          EXISTS(SELECT 1 FROM crm.olist_resources WHERE account_key=$1 AND state IN ('reserved','uncertain')) OR
          EXISTS(SELECT 1 FROM crm.olist_attempts a
            LEFT JOIN crm.olist_resources r ON r.id=a.resource_id AND r.account_key=a.account_key
            LEFT JOIN crm.olist_resources parent ON parent.id=r.parent_id AND parent.account_key=r.account_key AND parent.kind='product'
            LEFT JOIN crm.olist_exports e ON e.id=a.export_id AND e.account_key=a.account_key
            WHERE a.account_key=$1 AND (a.outcome='reserved' OR
              ((a.outcome='uncertain' OR a.safe_code ~ '(DIVERGENT|READBACK_MISMATCH|RECONCILIATION_REQUIRED|UNCERTAIN)')
               AND NOT COALESCE(
                 (a.resource_id IS NOT NULL AND r.state='confirmed' AND r.remote_id IS NOT NULL
                   AND (a.observed_remote_id IS NULL OR a.observed_remote_id=r.remote_id
                     OR (r.kind='variation' AND parent.state='confirmed' AND parent.remote_id IS NOT NULL
                       AND parent.remote_id<>r.remote_id AND a.observed_remote_id=parent.remote_id))) OR
                 (a.export_id IS NOT NULL AND e.state IN ('confirmed','linked') AND e.remote_id IS NOT NULL
                   AND (a.observed_remote_id IS NULL OR a.observed_remote_id=e.remote_id)
                   AND (a.observed_remote_number IS NULL OR a.observed_remote_number=e.remote_number)),false)))) OR
          EXISTS(SELECT 1 FROM crm.olist_read_requests WHERE account_key=$1 AND status='queued') OR
          EXISTS(SELECT 1 FROM (
            SELECT DISTINCT ON (export_id,resource_id,stage) status,export_id FROM crm.olist_read_requests WHERE account_key=$1
            ORDER BY export_id,resource_id,stage,created_at DESC,id DESC
          ) latest WHERE status='blocked' AND NOT EXISTS(SELECT 1 FROM crm.olist_exports held WHERE held.id=latest.export_id AND held.account_key=$1 AND held.state='legacy_review_required' AND held.remote_id IS NOT NULL AND crm.olist_legacy_withdrawal_clear(held.id,held.account_key))) OR
          EXISTS(SELECT 1 FROM crm.outbox_jobs j JOIN crm.olist_exports e ON e.id=j.olist_export_id
            WHERE e.account_key=$1 AND j.job_type IN ('olist.export','olist.reconcile') AND j.status='processing') AS blocked`,
            [config.accountKey],
          )
        ).rows[0];
        if (evidence.blocked) throw new OlistError('OLIST_RECOVERY_BLOCKED');
        await client.query(
          'UPDATE crm.olist_accounts SET recovery_required=false WHERE account_key=$1',
          [config.accountKey],
        );
        const saved = (
          await client.query(
            'UPDATE crm.olist_connections SET version=version+1,updated_at=$2 WHERE context_key=$1 RETURNING *',
            [config.contextKey, clock()],
          )
        ).rows[0];
        await event(
          client,
          input,
          'OLIST_RECOVERY_CONFIRMED',
          Number(saved.version),
        );
        return projection(client, saved);
      });
    },
    /** Local administrative switch; recovery remains an independent gate.
     * @param {any} input */
    async creation(input) {
      requireConfigured();
      integer(input.expectedVersion, true);
      text(input.reason, 500);
      if (typeof input.enabled !== 'boolean')
        throw new OlistError('INVALID_REQUEST', 400);
      return transaction(input, async (/** @type {any} */ client) => {
        await lockOlistActor(client, input, 'olist.manage', clock());
        const row = await lockConnection(client);
        const account = (
          await client.query(
            'SELECT * FROM crm.olist_accounts WHERE account_key=$1 FOR UPDATE',
            [config.accountKey],
          )
        ).rows[0];
        if (Number(row.version) !== input.expectedVersion)
          throw new OlistError('VERSION_CONFLICT');
        if (input.enabled) {
          if (!config.pilotUserIds.length || account.recovery_required)
            throw new OlistError('OLIST_CREATION_DISABLED');
          if (
            !row.token_envelope ||
            row.reconnect_required ||
            row.refresh_nonce ||
            row.exchange_nonce ||
            !row.expires_at ||
            new Date(row.expires_at) <= clock()
          )
            throw new OlistError('OLIST_RECONNECT_REQUIRED');
          const settings = (
            await client.query(
              'SELECT settings_envelope FROM crm.olist_settings WHERE account_key=$1 FOR SHARE',
              [config.accountKey],
            )
          ).rows[0];
          if (!settings?.settings_envelope)
            throw new OlistError('OLIST_ORDER_INCOMPLETE');
          const pilots = await client.query(
            'SELECT id FROM crm.users WHERE id=ANY($1::text[]) AND disabled_at IS NULL AND olist_enabled=true FOR SHARE',
            [config.pilotUserIds],
          );
          if (pilots.rows.length !== config.pilotUserIds.length)
            throw new OlistError('OLIST_CREATION_DISABLED');
        }
        await client.query(
          'UPDATE crm.olist_accounts SET creation_enabled=$2 WHERE account_key=$1',
          [config.accountKey, input.enabled],
        );
        const saved = (
          await client.query(
            'UPDATE crm.olist_connections SET version=version+1,updated_at=$2 WHERE context_key=$1 RETURNING *',
            [config.contextKey, clock()],
          )
        ).rows[0];
        await event(
          client,
          input,
          input.enabled ? 'OLIST_CREATION_ENABLED' : 'OLIST_CREATION_DISABLED',
          Number(saved.version),
        );
        return projection(client, saved);
      });
    },
    /** @param {any} input */
    async authorize(input) {
      requireConfigured();
      const state = randomBytes(32).toString('base64url');
      await transaction(input, async (/** @type {any} */ client) => {
        await lockOlistActor(client, input, 'olist.manage', clock());
        const connection = await lockConnection(client);
        await client.query(
          'DELETE FROM crm.olist_oauth_states WHERE expires_at<=$1',
          [clock()],
        );
        await client.query(
          'INSERT INTO crm.olist_oauth_states(state_hash,context_key,actor_id,session_hash,connection_version,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(context_key,actor_id,session_hash) DO UPDATE SET state_hash=excluded.state_hash,connection_version=excluded.connection_version,expires_at=excluded.expires_at',
          [
            hash(state),
            config.contextKey,
            input.actor.id,
            input.sessionBinding,
            connection.version,
            new Date(clock().getTime() + 600_000),
          ],
        );
      });
      const url = new URL(OLIST_AUTH);
      for (const [key, value] of Object.entries({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: 'openid',
        response_type: 'code',
        state,
      }))
        url.searchParams.set(key, value);
      return { authorizationUrl: url.href };
    },
    /** @param {any} input */
    async complete(input) {
      requireConfigured();
      if (
        typeof input.state !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/u.test(input.state) ||
        typeof input.code !== 'string' ||
        !input.code ||
        input.code.length > 4096 ||
        /[\u0000-\u0020\u007f]/u.test(input.code)
      )
        throw new OlistError('INVALID_REQUEST', 400);
      const claim = await database.transaction(
        async (/** @type {any} */ client) => {
          await lockOlistActor(client, input, 'olist.manage', clock());
          const row = await lockConnection(client);
          const { rows } = await client.query(
            'DELETE FROM crm.olist_oauth_states WHERE state_hash=$1 AND context_key=$2 AND actor_id=$3 AND session_hash=$4 RETURNING *',
            [
              hash(input.state),
              config.contextKey,
              input.actor.id,
              input.sessionBinding,
            ],
          );
          const state = rows[0];
          if (
            !state ||
            new Date(state.expires_at) <= clock() ||
            Number(state.connection_version) !== Number(row.version)
          )
            return { error: new OlistError('OLIST_INVALID_STATE') };
          const nonce = randomUUID();
          const reserved = await client.query(
            'UPDATE crm.olist_connections SET token_envelope=NULL,expires_at=NULL,refresh_expires_at=NULL,refresh_nonce=NULL,refresh_started_at=NULL,exchange_nonce=$2,reconnect_required=true,generation=generation+1,version=version+1,updated_at=$3 WHERE context_key=$1 RETURNING version',
            [config.contextKey, nonce, clock()],
          );
          await event(
            client,
            input,
            'OLIST_CONNECT_RESERVED',
            Number(reserved.rows[0].version),
          );
          return { nonce, version: Number(reserved.rows[0].version) };
        },
      );
      if (claim.error) throw claim.error;
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        code: input.code,
      });
      const result = await finishToken(
        input,
        claim,
        'olist.manage',
        () => tokens(form),
        false,
      );
      if (result.error) throw result.error;
      return result.status;
    },
    /** @param {any} input @param {string} [action] */
    async credentials(input, action = 'olist.manage') {
      requireConfigured();
      const claim = await database.transaction(
        async (/** @type {any} */ client) => {
          await lockOlistActor(client, input, action, clock());
          const row = await lockConnection(client);
          if (row.reconnect_required || !row.token_envelope)
            return { error: new OlistError('OLIST_RECONNECT_REQUIRED') };
          if (row.refresh_nonce) {
            if (
              clock().getTime() - new Date(row.refresh_started_at).getTime() <
              60_000
            )
              return {
                error: new OlistError('OLIST_REFRESH_IN_PROGRESS', 503),
              };
            await invalidate(client, input, row, 'OLIST_REFRESH_ABANDONED');
            return { error: new OlistError('OLIST_RECONNECT_REQUIRED') };
          }
          let stored;
          try {
            stored = open(
              row.token_envelope,
              config.envelopeKey,
              'tokens',
              config.accountKey,
              config.contextKey,
            );
            if (
              typeof stored?.accessToken !== 'string' ||
              !stored.accessToken ||
              typeof stored?.refreshToken !== 'string' ||
              !stored.refreshToken ||
              /[\u0000-\u0020\u007f]/u.test(
                stored.accessToken + stored.refreshToken,
              )
            )
              throw new Error();
          } catch {
            await invalidate(client, input, row, 'OLIST_RECONNECT_REQUIRED');
            return { error: new OlistError('OLIST_RECONNECT_REQUIRED') };
          }
          if (new Date(row.expires_at).getTime() > clock().getTime() + 60_000)
            return { token: stored.accessToken, version: Number(row.version) };
          if (
            row.refresh_expires_at &&
            new Date(row.refresh_expires_at) <= clock()
          ) {
            await invalidate(client, input, row, 'OLIST_RECONNECT_REQUIRED');
            return { error: new OlistError('OLIST_RECONNECT_REQUIRED') };
          }
          const nonce = randomUUID();
          const reserved = await client.query(
            'UPDATE crm.olist_connections SET refresh_nonce=$2,refresh_started_at=$3,version=version+1,updated_at=$3 WHERE context_key=$1 RETURNING version',
            [config.contextKey, nonce, clock()],
          );
          await event(
            client,
            input,
            'OLIST_REFRESH_RESERVED',
            Number(reserved.rows[0].version),
          );
          return {
            nonce,
            version: Number(reserved.rows[0].version),
            refreshToken: stored.refreshToken,
            refreshExpiresAt: row.refresh_expires_at
              ? new Date(row.refresh_expires_at)
              : null,
          };
        },
      );
      if (claim.error) throw claim.error;
      if (claim.token) return { token: claim.token, version: claim.version };
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: claim.refreshToken,
      });
      const result = await finishToken(
        input,
        claim,
        action,
        () => tokens(form, claim.refreshExpiresAt),
        true,
      );
      if (result.error) throw result.error;
      return { token: result.token, version: result.version };
    },
    /** @param {any} input @param {number} version */
    async authFailure(input, version) {
      await database.transaction(async (/** @type {any} */ client) => {
        const row = await lockConnection(client);
        if (Number(row.version) === version)
          await invalidate(client, input, row, 'OLIST_RECONNECT_REQUIRED');
      });
    },
    /** @param {any} input */
    async disconnect(input) {
      requireConfigured();
      integer(input.expectedVersion, true);
      text(input.reason, 500);
      return transaction(input, async (/** @type {any} */ client) => {
        await lockOlistActor(client, input, 'olist.manage', clock());
        const row = await lockConnection(client);
        if (Number(row.version) !== input.expectedVersion)
          throw new OlistError('VERSION_CONFLICT');
        const saved = await invalidate(
          client,
          input,
          row,
          'OLIST_DISCONNECTED',
        );
        await client.query(
          'UPDATE crm.olist_connections SET reconnect_required=false WHERE context_key=$1',
          [config.contextKey],
        );
        await client.query(
          'DELETE FROM crm.olist_oauth_states WHERE context_key=$1',
          [config.contextKey],
        );
        return projection(client, { ...saved, reconnect_required: false });
      });
    },
    /** @param {any} input */
    async settings(input) {
      requireConfigured();
      integer(input.expectedVersion, true);
      text(input.reason, 500);
      const settings = olistSettings(input.settings);
      return transaction(input, async (/** @type {any} */ client) => {
        await lockOlistActor(client, input, 'olist.manage', clock());
        const connection = await lockConnection(client);
        const { rows } = await client.query(
          'SELECT * FROM crm.olist_settings WHERE account_key=$1 FOR UPDATE',
          [config.accountKey],
        );
        if (Number(rows[0].version) !== input.expectedVersion)
          throw new OlistError('VERSION_CONFLICT');
        await client.query(
          'UPDATE crm.olist_settings SET settings_envelope=$2::jsonb,version=version+1,updated_by=$3,updated_at=$4 WHERE account_key=$1',
          [
            config.accountKey,
            JSON.stringify(
              seal(
                settings,
                config.envelopeKey,
                'settings',
                config.accountKey,
                'central',
              ),
            ),
            input.actor.id,
            clock(),
          ],
        );
        await event(
          client,
          input,
          'OLIST_SETTINGS_CHANGED',
          input.expectedVersion + 1,
        );
        return projection(client, connection);
      });
    },
  });
}
