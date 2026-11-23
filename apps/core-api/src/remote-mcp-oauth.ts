import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, exists, gt, inArray, isNotNull, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import { createAuthRateLimiter, generateToken, hashToken } from '@team-synergy/application';
import { PublicCodeSchema } from '@team-synergy/contracts';
import { schema, type Db } from '@team-synergy/persistence';
import { unauthorized } from './auth.js';
import { authorizeRemoteMcpGrantSubject, createRemoteMcpGrant } from './remote-mcp-authorization.js';

const clients = schema.remoteMcpOAuthClients;
const requests = schema.remoteMcpOAuthRequests;
const grants = schema.remoteMcpGrants;
const refreshTokens = schema.remoteMcpOAuthRefreshTokens;
const basePath = '/mcp/oauth';
const baseScope = 'project:read';
const taskScope = 'tasks:write';
const workspaceScope = 'workspace:write';
const memoryScope = 'memory:personal:read';
const supportedScopes = new Set([baseScope, taskScope, memoryScope, workspaceScope]);
const clientIdPattern = /^tsp_mcp_client_[a-f0-9]{64}$/;
const opaqueIdPattern = /^[a-f0-9]{64}$/;
const proofPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const accessLifetimeMs = 60 * 60 * 1000;
const requestLifetimeMs = 15 * 60 * 1000;
const codeLifetimeMs = 5 * 60 * 1000;
const publicClientUnclaimedLifetimeMs = 24 * 60 * 60 * 1000;
const authMethods = ['none', 'client_secret_post', 'client_secret_basic'] as const;
type OAuthClient = typeof clients.$inferSelect;
type TokenForm = Record<string, string>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function loopback(host: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

function validateResource(raw: string): URL {
  const url = new URL(raw);
  const testLoopback = process.env.NODE_ENV !== 'production' && process.env.ACP_ENV !== 'production'
    && url.protocol === 'http:' && loopback(url.hostname);
  if ((!testLoopback && url.protocol !== 'https:') || !url.pathname.endsWith('/mcp')
    || url.username || url.password || url.search || url.hash || url.href !== raw) {
    throw new Error('Remote MCP resource must be a canonical HTTPS URL ending in /mcp');
  }
  return url;
}

export function remoteMcpResourceMetadataUrl(resourceUrl: string): string {
  return new URL('./.well-known/oauth-protected-resource', resourceUrl).href;
}

function allowedRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\p{Cc}]/u.test(value)) return false;
  try {
    const uri = new URL(value);
    return !uri.username && !uri.password && !value.includes('#')
      && (uri.protocol === 'https:' || (uri.protocol === 'http:' && loopback(uri.hostname)))
      && !['code', 'state', 'iss', 'error', 'error_description'].some(key => uri.searchParams.has(key));
  } catch {
    return false;
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
}

function oauthError(reply: FastifyReply, code: string, message: string, status = 400) {
  noStore(reply);
  return reply.code(status).send({ error: code, error_description: message });
}

function consentError(reply: FastifyReply, code: string, message: string, httpStatus: number) {
  return reply.code(httpStatus).send({ ok: false as const, error: { code, message } });
}

function requestUnavailable(reply: FastifyReply) {
  return consentError(reply, 'mcp_oauth_request_unavailable', '此连接请求已失效，请在 Agent 中重新连接。', 404);
}

function uniqueForm(input: URLSearchParams): TokenForm | null {
  const output: TokenForm = Object.create(null) as TokenForm;
  for (const [key, value] of input) {
    if (Object.hasOwn(output, key)) return null;
    output[key] = value;
  }
  return output;
}

function oauthRedirect(uri: string, issuer: string, state: string | null | undefined, result: Record<string, string>): string {
  const redirect = new URL(uri);
  for (const [key, value] of Object.entries(result)) redirect.searchParams.set(key, value);
  if (state !== undefined && state !== null) redirect.searchParams.set('state', state);
  redirect.searchParams.set('iss', issuer);
  return redirect.href;
}

function sameDigest(left: string, right: string): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function parseBasic(header: string | undefined): { clientId: string; secret: string } | null {
  if (header === undefined) return null;
  const match = /^Basic ([A-Za-z0-9+/]{1,2048}={0,2})$/i.exec(header);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 1) return null;
  try {
    return {
      clientId: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')),
      secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')),
    };
  } catch {
    return null;
  }
}

function authenticatedClient(client: OAuthClient, form: TokenForm, authorization: string | undefined, basic: ReturnType<typeof parseBasic>): boolean {
  if (client.token_auth_method === 'none') return authorization === undefined && form.client_secret === undefined;
  const supplied = client.token_auth_method === 'client_secret_basic'
    ? (form.client_secret === undefined ? basic?.secret : undefined)
    : (authorization === undefined ? form.client_secret : undefined);
  return !!supplied && !!client.secret_hash && sameDigest(hashToken(supplied), client.secret_hash);
}

function scopeFor(permissions: Pick<typeof grants.$inferSelect, 'allow_task_write' | 'allow_personal_memory' | 'allow_workspace_write'>): string {
  return [baseScope, ...(permissions.allow_task_write ? [taskScope] : []),
    ...(permissions.allow_personal_memory ? [memoryScope] : []), ...(permissions.allow_workspace_write ? [workspaceScope] : [])].join(' ');
}

async function createRefreshToken(tx: Tx, grantId: bigint) {
  const token = 'tsp_mcp_refresh_' + generateToken();
  await tx.insert(refreshTokens).values({ token_hash: hashToken(token), grant_id: grantId });
  return token;
}

function tokenResponse(accessToken: string, expiresSeconds: number, scope: string, refreshToken?: string) {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresSeconds,
    scope,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
}

async function exchangeCode(db: Db, form: TokenForm, client: OAuthClient, resourceUrl: string) {
  const { code, code_verifier: verifier, redirect_uri: redirect } = form;
  if (!code || !opaqueIdPattern.test(code) || !verifier || !proofPattern.test(verifier) || !redirect) return null;
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return db.transaction(async tx => {
    const [row] = await tx.select({ request: requests, principalCode: schema.users.code, projectCode: schema.projects.code })
      .from(requests)
      .innerJoin(schema.users, eq(schema.users.id, requests.principal_id))
      .leftJoin(schema.projects, eq(schema.projects.id, requests.project_id))
      .where(and(eq(requests.code_hash, hashToken(code)), eq(requests.client_id, client.id),
        eq(requests.resource_uri, resourceUrl), eq(requests.redirect_uri, redirect), gt(requests.expires_at, sqlNow)))
      .limit(1);
    if (!row || (row.projectCode === null && row.request.project_id !== null) || !sameDigest(row.request.challenge, challenge)) return null;
    const subject = await authorizeRemoteMcpGrantSubject(tx, row.principalCode, row.projectCode,
      row.request.allow_task_write || row.request.allow_workspace_write);
    if (!subject) return null;

    // Claim the approved code only after locking its project/account. A password reset
    // can delete it between the initial lookup and those locks.
    const [consumed] = await tx.delete(requests).where(and(eq(requests.id, row.request.id),
      eq(requests.code_hash, hashToken(code)), gt(requests.expires_at, sqlNow))).returning({ id: requests.id });
    if (!consumed) return null;
    const { grantId, token } = await createRemoteMcpGrant(tx, {
      ...subject, projectCode: row.projectCode, name: client.name,
      allowTaskWrite: row.request.allow_task_write, allowPersonalMemory: row.request.allow_personal_memory,
      allowWorkspaceWrite: row.request.allow_workspace_write,
      oauth: { clientId: client.id, resourceUrl, accessLifetimeMs },
    });
    const refreshToken = client.allow_refresh ? await createRefreshToken(tx, grantId) : undefined;
    return tokenResponse(token, accessLifetimeMs / 1_000, scopeFor(row.request), refreshToken);
  });
}

async function exchangeRefreshToken(db: Db, form: TokenForm, client: OAuthClient, resourceUrl: string) {
  const token = form.refresh_token;
  if (!client.allow_refresh || !token || !/^tsp_mcp_refresh_[a-f0-9]{64}$/.test(token)) return null;
  const hash = hashToken(token);
  return db.transaction(async tx => {
    const [row] = await tx.select({ grantId: grants.id, grantProjectId: grants.project_id, principalCode: schema.users.code, projectCode: schema.projects.code })
      .from(grants)
      .innerJoin(refreshTokens, eq(refreshTokens.grant_id, grants.id))
      .innerJoin(schema.users, eq(schema.users.id, grants.principal_id))
      .leftJoin(schema.projects, eq(schema.projects.id, grants.project_id))
      .where(and(eq(refreshTokens.token_hash, hash), eq(grants.oauth_client_id, client.id), eq(grants.resource_uri, resourceUrl),
        isNull(grants.revoked_at), gt(grants.expires_at, sqlNow)))
      .limit(1);
    if (!row || (row.projectCode === null && row.grantProjectId !== null)) return null;
    const subject = await authorizeRemoteMcpGrantSubject(tx, row.principalCode, row.projectCode, false);
    if (!subject) return null;
    // Recheck the grant after the account lock. A password reset may have revoked it.
    // Read the rotation marker after this grant lock to serialize refresh attempts.
    const [grant] = await tx.select().from(grants).where(and(eq(grants.id, row.grantId),
      eq(grants.principal_id, subject.principalId), subject.projectId === null ? isNull(grants.project_id) : eq(grants.project_id, subject.projectId),
      isNull(grants.revoked_at), gt(grants.expires_at, sqlNow))).limit(1).for('update');
    if (!grant) return null;
    const [entry] = await tx.select({ usedAt: refreshTokens.used_at }).from(refreshTokens)
      .where(eq(refreshTokens.token_hash, hash)).limit(1);
    if (!entry) return null;
    const now = new Date();
    if (entry.usedAt) {
      await tx.update(grants).set({ revoked_at: now }).where(eq(grants.id, grant.id));
      return null;
    }
    const scope = scopeFor(grant);
    if (form.scope !== undefined && form.scope !== scope) return null;
    const expires = Math.min(now.getTime() + accessLifetimeMs, grant.expires_at.getTime());
    const accessToken = 'tsp_mcp_' + generateToken();
    await tx.update(refreshTokens).set({ used_at: now }).where(eq(refreshTokens.token_hash, hash));
    await tx.update(grants).set({ token_hash: hashToken(accessToken), access_expires_at: new Date(expires) }).where(eq(grants.id, grant.id));
    return tokenResponse(accessToken, Math.floor((expires - now.getTime()) / 1_000), scope, await createRefreshToken(tx, grant.id));
  });
}

const sqlNow = sql.raw('now()');

export function registerRemoteMcpOAuthRoutes(app: FastifyInstance, db: Db, options: { resourceUrl: string }): void {
  const resource = validateResource(options.resourceUrl);
  const issuer = resource.origin;
  const endpoint = (suffix: string) => new URL('./mcp/oauth/' + suffix, resource).href;
  const quota = createAuthRateLimiter(db);

  app.get('/.well-known/oauth-protected-resource', { logLevel: 'silent' }, async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    return { resource: resource.href, authorization_servers: [issuer], scopes_supported: [baseScope], bearer_methods_supported: ['header'] };
  });
  app.get('/.well-known/oauth-authorization-server', { logLevel: 'silent' }, async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    return {
      issuer,
      authorization_endpoint: endpoint('authorize'),
      token_endpoint: endpoint('token'),
      registration_endpoint: endpoint('register'),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: authMethods,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [...supportedScopes],
    };
  });

  app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      done(null, typeof body === 'string' ? uniqueForm(new URLSearchParams(body)) : null);
    });

    async function applyQuota(reply: FastifyReply, request: FastifyRequest, key: string, minute: number, hour: number) {
      const retry = await quota(key, request.ip, undefined, minute, hour);
      if (retry <= 0) return false;
      reply.header('Retry-After', retry);
      oauthError(reply, 'temporarily_unavailable', 'Please retry this request later.', 429);
      return true;
    }

    for (const path of [basePath + '/register', basePath + '/token']) {
      scope.options(path, { logLevel: 'silent' }, async (_request, reply) => {
        reply.header('Access-Control-Allow-Origin', '*')
          .header('Access-Control-Allow-Methods', 'POST')
          .header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        return reply.code(204).send();
      });
    }
    scope.post(basePath + '/register', { bodyLimit: 16_384, logLevel: 'silent' }, async (request, reply) => {
      noStore(reply);
      reply.header('Access-Control-Allow-Origin', '*');
      if (await applyQuota(reply, request, 'remote-mcp-registration', 15, 120)) return;
      const body = objectOf(request.body);
      if (!body) return oauthError(reply, 'invalid_client_metadata', 'Client metadata must be a JSON object.');
      const redirects = body.redirect_uris;
      if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 5
        || !redirects.every(allowedRedirectUri) || new Set(redirects.map(value => new URL(value).href)).size !== redirects.length) {
        return oauthError(reply, 'invalid_redirect_uri', 'Register one to five distinct HTTPS or loopback callback URLs.');
      }
      const authMethod = body.token_endpoint_auth_method ?? 'client_secret_basic';
      const grantTypes = body.grant_types ?? ['authorization_code'];
      const responseTypes = body.response_types ?? ['code'];
      const name = typeof body.client_name === 'string' ? body.client_name.trim() : 'Remote Agent';
      if (!authMethods.some(method => method === authMethod)
        || !Array.isArray(grantTypes) || !grantTypes.includes('authorization_code')
        || grantTypes.some(type => type !== 'authorization_code' && type !== 'refresh_token')
        || new Set(grantTypes).size !== grantTypes.length
        || !Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code'
        || !name || [...name].length > 100 || /[\p{Cc}\p{Cf}]/u.test(name)
        || (body.scope !== undefined && (typeof body.scope !== 'string'
          || body.scope.split(/ +/).some(value => !supportedScopes.has(value))))) {
        return oauthError(reply, 'invalid_client_metadata', 'Use authorization code with PKCE and supported client authentication.');
      }
      const id = 'tsp_mcp_client_' + generateToken();
      const secret = authMethod === 'none' ? undefined : generateToken();
      const now = new Date();

      await db.transaction(async tx => {
        // Bounded by registration quotas. Keep client identities that already have a
        // grant so returning members can reauthorize without adding the connector again.
        await tx.delete(requests).where(lt(requests.expires_at, now));
        await tx.delete(refreshTokens).where(inArray(refreshTokens.grant_id,
          tx.select({ id: grants.id }).from(grants).where(or(lt(grants.expires_at, now), isNotNull(grants.revoked_at)))));
        await tx.delete(clients).where(and(lt(clients.created_at, new Date(now.getTime() - publicClientUnclaimedLifetimeMs)),
          notExists(tx.select({ id: grants.id }).from(grants).where(eq(grants.oauth_client_id, clients.id))),
          notExists(tx.select({ id: requests.id }).from(requests).where(eq(requests.client_id, clients.id)))));
        await tx.insert(clients).values({ id, name, secret_hash: secret ? hashToken(secret) : null,
          token_auth_method: authMethod as OAuthClient['token_auth_method'], redirect_uris: redirects,
          allow_refresh: grantTypes.includes('refresh_token'), created_at: now });
      });

      return reply.code(201).send({
        client_id: id, client_id_issued_at: Math.floor(now.getTime() / 1_000), client_name: name,
        redirect_uris: redirects, grant_types: grantTypes, response_types: responseTypes, token_endpoint_auth_method: authMethod,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      });
    });

    scope.get(basePath + '/authorize', { logLevel: 'silent' }, async (request, reply) => {
      noStore(reply);
      if (await applyQuota(reply, request, 'remote-mcp-authorize', 30, 180)) return;
      const url = new URL(request.url, issuer);
      const query = uniqueForm(url.searchParams);
      if (!query?.client_id || !clientIdPattern.test(query.client_id) || !allowedRedirectUri(query.redirect_uri)
        || (query.state !== undefined && (query.state.length > 1024 || /[\p{Cc}]/u.test(query.state)))) {
        return oauthError(reply, 'invalid_request', 'Client or callback is invalid.');
      }
      const currentTime = new Date();
      const [client] = await db.select().from(clients).where(and(eq(clients.id, query.client_id),
        or(gt(clients.created_at, new Date(currentTime.getTime() - publicClientUnclaimedLifetimeMs)),
          exists(db.select({ id: grants.id }).from(grants).where(eq(grants.oauth_client_id, clients.id))))))
        .limit(1);
      if (!client || !client.redirect_uris.includes(query.redirect_uri)) {
        return oauthError(reply, 'invalid_request', 'The callback does not match the registered client.');
      }
      if (query.response_type !== 'code') {
        return oauthError(reply, 'unsupported_response_type', 'Use the authorization code flow.');
      }
      if (query.resource !== undefined && query.resource !== resource.href) {
        return oauthError(reply, 'invalid_target', 'The requested resource is unavailable.');
      }
      const challenge = query.code_challenge;
      if (query.code_challenge_method !== 'S256' || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
        return oauthError(reply, 'invalid_request', 'PKCE S256 is required.');
      }
      const scopes = query.scope === undefined || query.scope === '' ? [baseScope] : query.scope.split(/ +/);
      if (scopes.some(value => !supportedScopes.has(value))) {
        return oauthError(reply, 'invalid_scope', 'The requested scope is unavailable.');
      }
      const id = generateToken();
      const redirect = query.redirect_uri;
      await db.transaction(async tx => {
        await tx.delete(requests).where(lt(requests.expires_at, currentTime));
        await tx.insert(requests).values({
          id, client_id: client.id, resource_uri: resource.href, redirect_uri: redirect,
          state: query.state, challenge,
          requested_task_write: scopes.includes(taskScope), requested_personal_memory: scopes.includes(memoryScope),
          requested_workspace_write: scopes.includes(workspaceScope),
          expires_at: new Date(currentTime.getTime() + requestLifetimeMs),
        });
      });
      const consent = new URL('/agent/connect/authorize', issuer);
      consent.searchParams.set('request', id);
      return reply.redirect(consent.href, 303);
    });

    const consentPath = basePath + '/requests/:id';
    scope.get<{ Params: { id: string } }>(consentPath, { logLevel: 'silent' }, async (request, reply) => {
      noStore(reply);
      if (request.authKind !== 'cookie' || !request.authSessionCode || request.passwordChangeRequired) return unauthorized(reply);
      if (!opaqueIdPattern.test(request.params.id)) return requestUnavailable(reply);
      const [entry] = await db.update(requests).set({ browser_session_code: request.authSessionCode })
        .where(and(eq(requests.id, request.params.id), eq(requests.resource_uri, resource.href),
          gt(requests.expires_at, sqlNow), isNull(requests.code_hash),
          or(isNull(requests.browser_session_code), eq(requests.browser_session_code, request.authSessionCode))))
        .returning();
      if (!entry) return requestUnavailable(reply);
      const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, entry.client_id)).limit(1);
      if (!client) return requestUnavailable(reply);
      return { ok: true as const, data: {
        clientName: client.name,
        redirectOrigin: new URL(entry.redirect_uri).origin,
        requestedTaskWrite: entry.requested_task_write,
        requestedWorkspaceWrite: entry.requested_workspace_write,
        requestedPersonalMemory: entry.requested_personal_memory,
      } };
    });

    scope.post<{ Params: { id: string } }>(consentPath, { bodyLimit: 4096, logLevel: 'silent' }, async (request, reply) => {
      noStore(reply);
      const principal = request.principal;
      const browserSession = request.authSessionCode;
      if (request.authKind !== 'cookie' || !principal || !browserSession || request.passwordChangeRequired) return unauthorized(reply);
      if (!opaqueIdPattern.test(request.params.id)) return requestUnavailable(reply);
      const body = objectOf(request.body);
      if (!body || !['allow', 'deny'].includes(body.decision as string)
        || Object.keys(body).some(key => !['decision', 'projectCode', 'allowTaskWrite', 'allowPersonalMemory', 'allowWorkspaceWrite'].includes(key))
        || (body.allowTaskWrite !== undefined && typeof body.allowTaskWrite !== 'boolean')
        || (body.allowWorkspaceWrite !== undefined && typeof body.allowWorkspaceWrite !== 'boolean')
        || (body.allowPersonalMemory !== undefined && typeof body.allowPersonalMemory !== 'boolean')) {
        return consentError(reply, 'invalid_request', '请选择是否授权此连接。', 400);
      }
      const project = PublicCodeSchema.nullish().safeParse(body.projectCode);
      if (body.decision === 'allow' && !project.success) {
        return consentError(reply, 'invalid_request', '指定的项目无效。', 400);
      }
      const result = await db.transaction(async tx => {
        const pending = and(eq(requests.id, request.params.id), eq(requests.resource_uri, resource.href),
          eq(requests.browser_session_code, browserSession), gt(requests.expires_at, sqlNow), isNull(requests.code_hash));
        const callback = { redirect_uri: requests.redirect_uri, state: requests.state };
        if (body.decision === 'deny') {
          const [entry] = await tx.delete(requests).where(pending).returning(callback);
          if (!entry) return { kind: 'unavailable' as const };
          return { kind: 'redirect' as const, url: oauthRedirect(entry.redirect_uri, issuer, entry.state, { error: 'access_denied' }) };
        }
        const [candidate] = await tx.select({ id: requests.id }).from(requests).where(pending).limit(1);
        if (!candidate) return { kind: 'unavailable' as const };
        const allowTaskWrite = body.allowTaskWrite === true;
        const allowWorkspaceWrite = body.allowWorkspaceWrite === true;
        const subject = await authorizeRemoteMcpGrantSubject(tx, principal, project.data ?? null, allowTaskWrite || allowWorkspaceWrite);
        if (!subject) return { kind: 'forbidden' as const };
        const code = generateToken();
        const [entry] = await tx.update(requests).set({
          principal_id: subject.principalId, project_id: subject.projectId,
          allow_task_write: allowTaskWrite, allow_personal_memory: body.allowPersonalMemory === true,
          allow_workspace_write: allowWorkspaceWrite,
          code_hash: hashToken(code), expires_at: new Date(Date.now() + codeLifetimeMs),
        }).where(pending).returning(callback);
        if (!entry) return { kind: 'unavailable' as const };
        return { kind: 'redirect' as const, url: oauthRedirect(entry.redirect_uri, issuer, entry.state, { code }) };
      });
      switch (result.kind) {
        case 'unavailable': return requestUnavailable(reply);
        case 'forbidden': return consentError(reply, 'mcp_project_forbidden', '此账号无法对所选项目授予请求的权限。', 403);
        case 'redirect': return { ok: true as const, data: { redirectUrl: result.url } };
      }
    });

    scope.post(basePath + '/token', { bodyLimit: 8192, logLevel: 'silent' }, async (request, reply) => {
      noStore(reply);
      reply.header('Access-Control-Allow-Origin', '*');
      if (await applyQuota(reply, request, 'remote-mcp-token', 90, 600)) return;
      const form = request.body as TokenForm | null;
      if (!form || request.headers['content-type']?.split(';', 1)[0]?.toLowerCase() !== 'application/x-www-form-urlencoded') {
        return oauthError(reply, 'invalid_request', 'Send a form with distinct parameter names.');
      }
      const authorization = request.headers.authorization;
      const basic = parseBasic(authorization);
      const clientId = basic?.clientId ?? form.client_id;
      const [client] = clientId && clientIdPattern.test(clientId)
        ? await db.select().from(clients).where(eq(clients.id, clientId)).limit(1)
        : [];
      if (!client || (authorization !== undefined && !basic) || (form.client_id && form.client_id !== client.id)
        || !authenticatedClient(client, form, authorization, basic)) {
        if (authorization !== undefined) reply.header('WWW-Authenticate', 'Basic realm="TeamSynergy OAuth"');
        return oauthError(reply, 'invalid_client', 'Client authentication failed.', authorization === undefined ? 400 : 401);
      }
      if (form.resource !== undefined && form.resource !== resource.href) {
        return oauthError(reply, 'invalid_target', 'The requested resource is unavailable.');
      }
      const grantType = form.grant_type;
      if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
        return oauthError(reply, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
      }
      const result = grantType === 'authorization_code'
        ? await exchangeCode(db, form, client, resource.href)
        : await exchangeRefreshToken(db, form, client, resource.href);
      if (!result) return oauthError(reply, 'invalid_grant', 'The authorization could not be exchanged.');
      return result;
    });
  });
}
