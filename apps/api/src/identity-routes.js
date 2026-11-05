class IdentityRequestError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'IdentityRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * @param {import('fastify').FastifyInstance} api
 * @param {Record<string, any>} identity
 * @param {(request: object) => {correlationId: string}} contextFor
 */
export function registerIdentityRoutes(api, identity, contextFor) {
  api.post('/api/v1/bootstrap/identity', async (request, reply) => {
    return respond(reply, async () => {
      requireOrigin(request, identity.allowedOrigins);
      const body = requireBody(request.body);
      const result = await identity.bootstrap({
        bootstrapToken: requireHeader(request, 'x-bootstrap-token'),
        correlationId: contextFor(request).correlationId,
        email: requireString(body.email, 'email'),
        name: requireString(body.name, 'name'),
        password: requireString(body.password, 'password'),
        reason: requireString(body.reason, 'reason'),
      });
      return reply.code(201).send(result);
    });
  });

  api.get('/api/v1/users', async (request, reply) => {
    return respond(reply, async () => {
      requireReadOriginWhenPresent(request, identity.allowedOrigins);
      const cookies = parseCookies(request.headers.cookie);
      const result = await identity.listUsers({
        sessionToken: requireSessionCookie(cookies),
      });
      return reply.code(200).send(result);
    });
  });

  api.get('/api/v1/users/assignable', async (request, reply) => {
    return respond(reply, async () => {
      requireReadOriginWhenPresent(request, identity.allowedOrigins);
      const cookies = parseCookies(request.headers.cookie);
      const result = await identity.listAssignableUsers({
        sessionToken: requireSessionCookie(cookies),
      });
      return reply.code(200).send(result);
    });
  });

  api.post('/api/v1/users', async (request, reply) => {
    return respond(reply, async () => {
      const command = requireAuthenticatedCommand(
        request,
        identity.allowedOrigins,
      );
      const body = requireBody(request.body);
      const result = await identity.createUser({
        ...command,
        ...optionalAccessType(body.accessType),
        ...optionalOlistAuthorization(body, false),
        correlationId: contextFor(request).correlationId,
        email: requireString(body.email, 'email'),
        idempotencyKey: requireHeader(request, 'idempotency-key'),
        name: requireString(body.name, 'name'),
        password: requireString(body.password, 'password'),
        reason: requireString(body.reason, 'reason'),
      });
      return reply.code(201).send(result);
    });
  });

  api.patch('/api/v1/users/:id', async (request, reply) => {
    return respond(reply, async () => {
      const command = requireAuthenticatedCommand(
        request,
        identity.allowedOrigins,
      );
      const body = requireBody(request.body);
      const patch = {
        ...optionalAccessType(body.accessType),
        ...optionalOlistAuthorization(body, true),
        ...optionalString(body.email, 'email'),
        ...optionalString(body.name, 'name'),
        ...optionalString(body.password, 'password'),
      };
      if (Object.keys(patch).length === 0) {
        throw new IdentityRequestError(400, 'INVALID_REQUEST');
      }
      const result = await identity.updateUser({
        ...command,
        ...patch,
        correlationId: contextFor(request).correlationId,
        idempotencyKey: requireHeader(request, 'idempotency-key'),
        reason: requireString(body.reason, 'reason'),
        targetId: requireParam(request, 'id'),
      });
      return reply.code(200).send(result);
    });
  });

  api.delete('/api/v1/users/:id', async (request, reply) => {
    return respond(reply, async () => {
      const command = requireAuthenticatedCommand(
        request,
        identity.allowedOrigins,
      );
      const body = requireBody(request.body);
      const result = await identity.deleteUser({
        ...command,
        correlationId: contextFor(request).correlationId,
        idempotencyKey: requireHeader(request, 'idempotency-key'),
        reason: requireString(body.reason, 'reason'),
        targetId: requireParam(request, 'id'),
      });
      return reply.code(200).send(result);
    });
  });

  for (const change of ['disable', 'enable']) {
    api.post(`/api/v1/users/:id/${change}`, async (request, reply) => {
      return respond(reply, async () => {
        const command = requireAuthenticatedCommand(
          request,
          identity.allowedOrigins,
        );
        const body = requireBody(request.body);
        const result = await identity.setUserDisabled({
          ...command,
          correlationId: contextFor(request).correlationId,
          disabled: change === 'disable',
          idempotencyKey: requireHeader(request, 'idempotency-key'),
          reason: requireString(body.reason, 'reason'),
          targetId: requireParam(request, 'id'),
        });
        return reply.code(200).send(result);
      });
    });
  }

  api.post('/api/v1/sessions', async (request, reply) => {
    return respond(reply, async () => {
      requireOrigin(request, identity.allowedOrigins);
      const body = requireBody(request.body);
      const result = await identity.login({
        email: requireString(body.email, 'email'),
        network: request.ip,
        password: requireString(body.password, 'password'),
      });
      reply.header('set-cookie', [
        result.cookie,
        `crm_csrf=${result.csrfToken}; Path=/; Secure; SameSite=Lax`,
      ]);
      return reply.code(200).send(result.body);
    });
  });

  api.delete('/api/v1/sessions/current', async (request, reply) => {
    return respond(reply, async () => {
      const command = requireAuthenticatedCommand(
        request,
        identity.allowedOrigins,
      );
      await identity.logout(command);
      reply.header('set-cookie', [
        'crm_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
        'crm_csrf=; Path=/; Secure; SameSite=Lax; Max-Age=0',
      ]);
      return reply.code(204).send();
    });
  });

  api.get('/api/v1/sessions/current', async (request, reply) => {
    return respond(reply, async () => {
      const cookies = parseCookies(request.headers.cookie);
      const result = await identity.current({
        sessionToken: requireSessionCookie(cookies),
      });
      return reply.code(200).send(result);
    });
  });

  for (const change of ['grant', 'revoke']) {
    api.post(`/api/v1/capabilities/${change}`, async (request, reply) => {
      return respond(reply, async () => {
        const command = requireAuthenticatedCommand(
          request,
          identity.allowedOrigins,
        );
        const body = requireBody(request.body);
        const result = await identity.changeCapability({
          ...command,
          capability: requireString(body.capability, 'capability'),
          change,
          correlationId: contextFor(request).correlationId,
          idempotencyKey: requireHeader(request, 'idempotency-key'),
          reason: requireString(body.reason, 'reason'),
          targetId: requireString(body.targetId, 'targetId'),
        });
        return reply.code(200).send(result);
      });
    });
  }
}

/** @param {import('fastify').FastifyReply} reply @param {() => Promise<unknown>} work */
async function respond(reply, work) {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
  try {
    return await work();
  } catch (error) {
    const statusCode =
      error instanceof IdentityRequestError
        ? error.statusCode
        : readStatusCode(error);
    if (![400, 401, 403, 404, 409, 429, 503].includes(statusCode)) throw error;
    return reply.code(statusCode).send({
      error: { code: publicErrorCode(statusCode, error) },
    });
  }
}

/** @param {unknown} error */
function readStatusCode(error) {
  if (
    error &&
    typeof error === 'object' &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode;
  }
  return 500;
}

/** @param {number} statusCode @param {unknown} error */
function publicErrorCode(statusCode, error) {
  if (statusCode === 400) return 'INVALID_REQUEST';
  if (statusCode === 401) return 'INVALID_CREDENTIALS';
  if (statusCode === 403) return 'FORBIDDEN';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 409) {
    const code = readErrorCode(error);
    if (
      [
        'EMAIL_ALREADY_REGISTERED',
        'USER_HAS_HISTORY',
        'USER_IS_ADMINISTRATOR',
        'VERSION_CONFLICT',
      ].includes(code ?? '')
    ) {
      return code;
    }
    return 'IDEMPOTENCY_KEY_REUSED';
  }
  if (statusCode === 429) return 'AUTHENTICATION_THROTTLED';
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'IDENTITY_UNAVAILABLE'
  ) {
    return 'IDENTITY_UNAVAILABLE';
  }
  return 'SERVICE_UNAVAILABLE';
}

/** @param {import('fastify').FastifyRequest} request @param {string[]} allowedOrigins */
function requireOrigin(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (
    typeof origin !== 'string' ||
    !Array.isArray(allowedOrigins) ||
    !allowedOrigins.includes(origin)
  ) {
    throw new IdentityRequestError(403, 'FORBIDDEN');
  }
}

/**
 * Browsers omit Origin from same-origin safe-method requests. Preserve the
 * allowlist when a caller supplies Origin, but let authenticated GET requests
 * proceed without it; commands remain protected by Origin plus CSRF.
 * @param {import('fastify').FastifyRequest} request
 * @param {string[]} allowedOrigins
 */
function requireReadOriginWhenPresent(request, allowedOrigins) {
  if (request.headers.origin === undefined) return;
  requireOrigin(request, allowedOrigins);
}

/** @param {import('fastify').FastifyRequest} request @param {string[]} allowedOrigins */
function requireAuthenticatedCommand(request, allowedOrigins) {
  requireOrigin(request, allowedOrigins);
  const cookies = parseCookies(request.headers.cookie);
  const csrfCookie = cookies.get('crm_csrf');
  const csrfHeader = request.headers['x-csrf-token'];
  const sessionToken = cookies.get('crm_session');
  if (
    typeof csrfCookie !== 'string' ||
    csrfCookie === '' ||
    typeof csrfHeader !== 'string' ||
    csrfCookie !== csrfHeader ||
    typeof sessionToken !== 'string' ||
    sessionToken === ''
  ) {
    throw new IdentityRequestError(403, 'FORBIDDEN');
  }
  return {
    csrfToken: csrfCookie,
    sessionToken,
  };
}

/** @param {unknown} raw */
function parseCookies(raw) {
  if (raw === undefined) return new Map();
  if (typeof raw !== 'string') {
    throw new IdentityRequestError(400, 'INVALID_REQUEST');
  }
  const cookies = new Map();
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (cookies.has(name)) {
      throw new IdentityRequestError(400, 'INVALID_REQUEST');
    }
    cookies.set(name, value);
  }
  return cookies;
}

/** @param {Map<unknown, unknown>} cookies */
function requireSessionCookie(cookies) {
  const value = cookies.get('crm_session');
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IdentityRequestError(401, 'INVALID_CREDENTIALS');
  }
  return value;
}

/** @param {unknown} error */
function readErrorCode(error) {
  if (error && typeof error === 'object' && 'code' in error) {
    return typeof error.code === 'string' ? error.code : null;
  }
  return null;
}

/** @param {import('fastify').FastifyRequest} request @param {string} name */
function requireHeader(request, name) {
  return requireString(request.headers[name], name);
}

/** @param {import('fastify').FastifyRequest} request @param {string} name */
function requireParam(request, name) {
  const params = /** @type {Record<string, unknown>} */ (request.params ?? {});
  return requireString(params[name], name);
}

/**
 * Absent stays absent so a PATCH can leave a field untouched; present must
 * still be a non-empty string.
 *
 * @param {unknown} value @param {string} field
 */
function optionalString(value, field) {
  if (value === undefined) return {};
  return { [field]: requireString(value, field) };
}

/** @param {unknown} value @returns {{accessType?: 'seller'|'finance'|'admin'}} */
function optionalAccessType(value) {
  if (value === undefined) return {};
  if (value !== 'seller' && value !== 'finance' && value !== 'admin') {
    throw new IdentityRequestError(400, 'INVALID_REQUEST');
  }
  return { accessType: value };
}

/** @param {Record<string, unknown>} body @param {boolean} requireVersion
 * @returns {{olistEnabled?: boolean, expectedOlistAuthorizationVersion?: number}} */
function optionalOlistAuthorization(body, requireVersion) {
  if (body.olistEnabled === undefined) {
    if (body.expectedOlistAuthorizationVersion !== undefined)
      throw new IdentityRequestError(400, 'INVALID_REQUEST');
    return {};
  }
  if (typeof body.olistEnabled !== 'boolean')
    throw new IdentityRequestError(400, 'INVALID_REQUEST');
  if (!requireVersion) return { olistEnabled: body.olistEnabled };
  const version = body.expectedOlistAuthorizationVersion;
  if (!Number.isSafeInteger(version) || /** @type {number} */ (version) < 0)
    throw new IdentityRequestError(400, 'INVALID_REQUEST');
  return {
    olistEnabled: body.olistEnabled,
    expectedOlistAuthorizationVersion: /** @type {number} */ (version),
  };
}

/** @param {unknown} value @param {string} field */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IdentityRequestError(400, `INVALID_${field.toUpperCase()}`);
  }
  return value;
}

/** @param {unknown} value */
function requireBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityRequestError(400, 'INVALID_REQUEST');
  }
  return /** @type {Record<string, unknown>} */ (value);
}
