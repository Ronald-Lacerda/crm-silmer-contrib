import { createOlistAdministration } from './olist-administration.js';
import { createOlistExportCommand } from './olist-export-command.js';
import { createOlistPreview } from './olist-preview.js';
import {
  PostgresIdempotencyRecordStore,
  fingerprintCommand,
} from '@crm-silmer/integration-reliability';
import {
  createOlistConnection,
  createOlistClient,
  olistConfiguration,
  olistReadWait,
  lockOlistActor,
  OlistError,
  identityHash,
} from '@crm-silmer/olist';
/** @param {any} database @param {{access:any,environment?:Record<string,string|undefined>,fetch?:typeof fetch,clock?:()=>Date,timeoutMs?:number}} options */
export function createOlistApiRuntime(database, options) {
  const env = options.environment ?? process.env;
  const config = olistConfiguration(env);
  const clock = options.clock ?? (() => new Date());
  const connection = createOlistConnection(database, {
    config,
    fetch: options.fetch,
    clock,
    timeoutMs: options.timeoutMs,
  });
  const idemKey = Buffer.from(env.IDEMPOTENCY_ENVELOPE_KEY ?? '', 'base64url');
  const idempotency =
    idemKey.length === 32
      ? new PostgresIdempotencyRecordStore({ database, envelopeKey: idemKey })
      : null;
  /** @param {any} input @param {string} name */
  async function mutate(input, name) {
    // Replay revalidates current authorization before reading a stored response.
    await database.transaction((/** @type {any} */ client) =>
      lockOlistActor(client, input, 'olist.manage', clock()),
    );
    if (!config.configured) throw new OlistError('OLIST_NOT_CONFIGURED', 503);
    if (!idempotency) throw new OlistError('OLIST_NOT_CONFIGURED', 503);
    if (
      typeof input.idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.idempotencyKey)
    )
      throw new OlistError('INVALID_REQUEST', 400);
    const command =
      name === 'settings'
        ? {
            expectedVersion: input.expectedVersion,
            settings: input.settings,
            reason: input.reason,
          }
        : name === 'disconnect'
          ? { expectedVersion: input.expectedVersion, reason: input.reason }
          : {};
    // Include the session so a stored authorize URL cannot cross sessions.
    const fingerprint = identityHash(config.hmacKey, 'command', [
      name,
      input.actor.id,
      input.sessionBinding,
      fingerprintCommand(command),
    ]);
    const scopedDatabase = {
      query: database.query.bind(database),
      transaction: (/** @type {any} */ work) =>
        database.transaction(async (/** @type {any} */ client) => {
          await lockOlistActor(client, input, 'olist.manage', clock());
          return work(client);
        }),
    };
    const store = new PostgresIdempotencyRecordStore({
      database: scopedDatabase,
      envelopeKey: idemKey,
    });
    return store.execute(
      {
        scope: 'olist:' + config.contextKey + ':' + input.actor.id + ':' + name,
        key: input.idempotencyKey,
        fingerprint,
        actor: input.actor.id,
        action: 'olist.' + name,
        target: { type: 'olist-account', id: config.accountKey },
        version: input.expectedVersion ?? 0,
        reason: 'OLIST_' + name.toUpperCase(),
        correlationId: input.correlationId,
      },
      (client) =>
        connection[/** @type {'authorize'|'disconnect'|'settings'} */ (name)]({
          ...input,
          transaction: client,
        }),
    );
  }
  /** @param {any} input */
  async function project(input) {
    return database.transaction(async (/** @type {any} */ client) => {
      const actor = await lockOlistActor(
        client,
        input,
        input.action ?? 'olist.read',
        clock(),
      );
      const { rows } = await client.query(
        'SELECT o.id,o.number,o.status,o.manual_owner_id,c.assigned_user_id FROM crm.orders o LEFT JOIN crm.conversations c ON c.id=o.conversation_id WHERE o.id=$1',
        [input.orderId],
      );
      const order = rows[0];
      if (!order) throw new OlistError('ORDER_NOT_FOUND', 404);
      if (
        input.action === 'order.read' &&
        !actor.capabilities.includes('COMMERCIAL_ADMIN') &&
        order.manual_owner_id !== actor.id &&
        order.assigned_user_id !== actor.id
      )
        throw new OlistError('FORBIDDEN', 403);
      // One ACTIVE export per order/account; older generations stay as
      // `invalidated` history. Prefer the active row, else the latest
      // invalidated one (the panel explains why a new preview is possible).
      const exports = await client.query(
        "SELECT state,stage,remote_number,last_error_code FROM crm.olist_exports WHERE account_key=$1 AND order_id=$2 ORDER BY (state='invalidated'),created_at DESC,id DESC LIMIT 1",
        [config.accountKey, order.id],
      );
      const operation = exports.rows[0];
      return {
        orderId: order.id,
        number: order.number,
        status: order.status,
        creationEnabled: false,
        pendingFields: [
          {
            code: 'OLIST_CREATION_DISABLED',
            label: 'Geração Olist ainda indisponível.',
          },
        ],
        operation: operation
          ? {
              state: operation.state,
              stage: operation.stage,
              number: operation.remote_number ?? null,
              ...(operation.last_error_code
                ? { errorCode: operation.last_error_code }
                : {}),
            }
          : null,
      };
    });
  }
  const preview = createOlistPreview(database, {
    config,
    connection,
    environment: env,
    clock,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  return Object.freeze({
    /** @param {any} input */ authorizeRead: (input) =>
      options.access.authorizeRead(input),
    /** @param {any} input */ authorizeWrite: (input) =>
      options.access.authorizeWrite(input),
    status: connection.status,
    /** @param {any} input */ authorize: (input) => mutate(input, 'authorize'),
    complete: connection.complete,
    /** @param {any} input */ disconnect: (input) =>
      mutate(input, 'disconnect'),
    /** @param {any} input */ settings: (input) => mutate(input, 'settings'),
    preview: preview.preview,
    checkPreview: preview.checkPreview,
    ...createOlistExportCommand(database, {
      config,
      preview,
      environment: env,
      clock,
    }),
    ...createOlistAdministration(database, {
      config,
      connection,
      preview,
      environment: env,
      clock,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    }),
    project,
    /** @param {any} input */
    async lookup(input) {
      if (typeof input.query !== 'string' || input.query.length > 64)
        throw new OlistError('INVALID_REQUEST', 400);
      const query = input.query.trim();
      if (
        !/^(?:[0-9]{2,15}-CRM|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.test(
          query,
        )
      )
        throw new OlistError('INVALID_REQUEST', 400);
      const orderId = await database.transaction(
        async (/** @type {any} */ client) => {
          await lockOlistActor(client, input, 'olist.export', clock());
          const { rows } = await client.query(
            'SELECT id FROM crm.orders WHERE number=$1 OR id=$1',
            [query],
          );
          if (rows.length !== 1) throw new OlistError('ORDER_NOT_FOUND', 404);
          return rows[0].id;
        },
      );
      return project({ ...input, orderId, action: 'olist.read' });
    },
    /** @param {any} input */
    async lookups(input) {
      const client = createOlistClient({
        credentials: () => connection.credentials(input),
        quota: connection.quota,
        readWait: olistReadWait('api'),
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        onAuthFailure: (version) => connection.authFailure(input, version),
      });
      return { items: await client.catalog(input.kind) };
    },
    /** @param {any} input */
    async mappings(input) {
      if (
        typeof input.resourceId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
          input.resourceId,
        )
      )
        throw new OlistError('INVALID_REQUEST', 400);
      return database.transaction(async (/** @type {any} */ client) => {
        await lockOlistActor(client, input, 'olist.manage', clock());
        const { rows } = await client.query(
          'SELECT id,kind,state,remote_id FROM crm.olist_resources WHERE id=$1 AND account_key=$2',
          [input.resourceId, config.accountKey],
        );
        if (!rows[0]) throw new OlistError('OLIST_RESOURCE_NOT_FOUND', 404);
        return {
          id: rows[0].id,
          kind: rows[0].kind,
          state: rows[0].state,
          remoteId: rows[0].remote_id,
        };
      });
    },
  });
}
