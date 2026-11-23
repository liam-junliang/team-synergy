import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { createPublicCode, generateToken, hashToken, insertAudit, resolveProjectAccess } from '@team-synergy/application';
import { PublicCodeSchema } from '@team-synergy/contracts';
import { toAuditEvent } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import { unauthorized } from './auth.js';

const grants = schema.remoteMcpGrants;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const grantLifetimeMs = 7 * 24 * 60 * 60 * 1000;

const connectionFields = {
  code: grants.code,
  name: grants.name,
  allowPersonalMemory: grants.allow_personal_memory,
  allowTaskWrite: grants.allow_task_write,
  allowWorkspaceWrite: grants.allow_workspace_write,
  expiresAt: grants.expires_at,
  revokedAt: grants.revoked_at,
};

function describeConnection(connection: {
  code: string;
  name: string;
  allowPersonalMemory: boolean;
  allowTaskWrite: boolean;
  allowWorkspaceWrite: boolean;
  expiresAt: Date;
  revokedAt: Date | null;
}, projectCode: string | null) {
  return {
    code: connection.code,
    name: connection.name,
    projectCode,
    allowPersonalMemory: connection.allowPersonalMemory,
    allowTaskWrite: connection.allowTaskWrite,
    allowWorkspaceWrite: connection.allowWorkspaceWrite,
    expiresAt: connection.expiresAt.toISOString(),
    revokedAt: connection.revokedAt?.toISOString() ?? null,
  };
}

function webPrincipal(request: FastifyRequest): string | null {
  // The global auth hook validates the web cookie and CSRF on mutations.
  return request.authKind === 'cookie' && !request.passwordChangeRequired ? request.principal : null;
}

function parseNewGrant(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some(key => !['name', 'projectCode', 'allowPersonalMemory', 'allowTaskWrite', 'allowWorkspaceWrite'].includes(key))) return null;
  const input = body as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const project = PublicCodeSchema.nullish().safeParse(input.projectCode);
  if (!name || name.length > 100 || /[\p{Cc}]/u.test(name) || !project.success ||
      (input.allowPersonalMemory !== undefined && typeof input.allowPersonalMemory !== 'boolean') ||
      (input.allowTaskWrite !== undefined && typeof input.allowTaskWrite !== 'boolean') ||
      (input.allowWorkspaceWrite !== undefined && typeof input.allowWorkspaceWrite !== 'boolean')) return null;
  return {
    name, projectCode: project.data ?? null, allowPersonalMemory: input.allowPersonalMemory === true,
    allowTaskWrite: input.allowTaskWrite === true, allowWorkspaceWrite: input.allowWorkspaceWrite === true,
  };
}

export interface RemoteMcpGrant {
  connectionCode: string;
  principalCode: string;
  projectCode: string | null;
  allowPersonalMemory: boolean;
  allowTaskWrite: boolean;
  allowWorkspaceWrite?: boolean;
}

/** Validate the account credential and any legacy project binding on every MCP request. */
export async function resolveRemoteMcpGrant(db: Db, token: string, resourceUrl?: string): Promise<RemoteMcpGrant | null> {
  if (!/^tsp_mcp_[0-9a-f]{64}$/.test(token)) return null;
  const [grant] = await db.select({
    connectionCode: grants.code,
    principalId: schema.users.id,
    principalCode: schema.users.code,
    projectId: grants.project_id,
    projectCode: schema.projects.code,
    allowPersonalMemory: grants.allow_personal_memory,
    allowTaskWrite: grants.allow_task_write,
    allowWorkspaceWrite: grants.allow_workspace_write,
  }).from(grants)
    .innerJoin(schema.users, eq(schema.users.id, grants.principal_id))
    .leftJoin(schema.projects, eq(schema.projects.id, grants.project_id))
    .where(and(eq(grants.token_hash, hashToken(token)), isNull(grants.revoked_at), gt(grants.expires_at, sql`now()`),
      or(isNull(grants.oauth_client_id), resourceUrl ? and(eq(grants.resource_uri, resourceUrl), gt(grants.access_expires_at, sql`now()`)) : undefined),
      eq(schema.users.status, 'active'), isNull(schema.users.deleted_at), eq(schema.users.pending_deletion, false),
      eq(schema.users.must_change_password, false), or(isNull(grants.project_id), eq(schema.projects.status, 'active'))))
    .limit(1);

  if (!grant) return null;
  const role = grant.projectId === null ? null : (await resolveProjectAccess(db, grant.projectId, grant.principalId))?.role;
  if (grant.projectId !== null && !role) return null;
  return {
    connectionCode: grant.connectionCode, principalCode: grant.principalCode, projectCode: grant.projectCode,
    allowPersonalMemory: grant.allowPersonalMemory,
    allowTaskWrite: grant.allowTaskWrite && role !== 'viewer',
    allowWorkspaceWrite: grant.allowWorkspaceWrite && role !== 'viewer',
  };
}

export async function authorizeRemoteMcpGrantSubject(tx: Tx, principalCode: string, projectCode: string | null, allowProjectWrite: boolean) {
  // Preserve project→account lock order for previously project-bound connections.
  const project = projectCode === null ? undefined : (await tx.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.code, projectCode), eq(schema.projects.status, 'active'))).limit(1).for('share'))[0];
  if (projectCode !== null && !project) return null;
  const [actor] = await tx.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.code, principalCode), eq(schema.users.status, 'active'),
      isNull(schema.users.deleted_at), eq(schema.users.pending_deletion, false), eq(schema.users.must_change_password, false)))
    .limit(1).for('share');
  if (!actor) return null;
  if (project) {
    const access = await resolveProjectAccess(tx, project.id, actor.id);
    if (!access || (allowProjectWrite && access.role === 'viewer')) return null;
  }
  return { principalId: actor.id, projectId: project?.id ?? null };
}

export async function createRemoteMcpGrant(tx: Tx, input: {
  principalId: bigint; projectId: bigint | null; projectCode: string | null; name: string; allowTaskWrite: boolean; allowPersonalMemory: boolean; allowWorkspaceWrite: boolean;
  oauth?: { clientId: string; resourceUrl: string; accessLifetimeMs: number };
}) {
  const token = 'tsp_mcp_' + generateToken();
  const createdAt = new Date();
  const [connection] = await tx.insert(grants).values({
    principal_id: input.principalId,
    project_id: input.projectId,
    name: input.name,
    token_hash: hashToken(token),
    allow_personal_memory: input.allowPersonalMemory,
    allow_task_write: input.allowTaskWrite,
    allow_workspace_write: input.allowWorkspaceWrite,
    created_at: createdAt,
    expires_at: new Date(createdAt.getTime() + grantLifetimeMs),
    ...(input.oauth ? { oauth_client_id: input.oauth.clientId, resource_uri: input.oauth.resourceUrl,
      access_expires_at: new Date(createdAt.getTime() + input.oauth.accessLifetimeMs) } : {}),
  }).returning({ id: grants.id, ...connectionFields });
  if (!connection) throw new Error('Remote MCP grant was not saved');
  await insertAudit(tx, toAuditEvent({
    entity_type: 'remote_mcp_connection', entity_id: connection.id, principal_id: input.principalId,
    base_snapshot: 0, action: 'remote_mcp.connection_created',
    payload: {
      connection_code: connection.code, project_code: input.projectCode,
      allow_personal_memory: input.allowPersonalMemory, allow_task_write: input.allowTaskWrite,
      allow_workspace_write: input.allowWorkspaceWrite,
    },
  }, createPublicCode(), createdAt.toISOString()));
  return { grantId: connection.id, connection: describeConnection(connection, input.projectCode), token };
}
export function registerRemoteMcpGrantRoutes(app: FastifyInstance, db: Db): void {
  const base = '/account/mcp-connections';

  app.get(base, { logLevel: 'silent' }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const principal = webPrincipal(request);
    if (!principal) return unauthorized(reply);
    const rows = await db.select({ connection: connectionFields, projectCode: schema.projects.code })
      .from(grants)
      .innerJoin(schema.users, eq(schema.users.id, grants.principal_id))
      .leftJoin(schema.projects, eq(schema.projects.id, grants.project_id))
      .where(eq(schema.users.code, principal))
      .orderBy(desc(grants.created_at), desc(grants.id));
    return { ok: true as const, data: rows.map(row => describeConnection(row.connection, row.projectCode)) };
  });

  app.post(base, { bodyLimit: 4096, logLevel: 'silent' }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const principal = webPrincipal(request);
    if (!principal) return unauthorized(reply);
    const input = parseNewGrant(request.body);
    if (!input) return reply.code(400).send({
      ok: false, error: { code: 'mcp_connection_invalid', message: '请输入有效的连接名称、项目和权限。' },
    });

    const result = await db.transaction(async tx => {
      const subject = await authorizeRemoteMcpGrantSubject(tx, principal, input.projectCode, input.allowTaskWrite || input.allowWorkspaceWrite);
      if (!subject) return null;
      const { connection, token } = await createRemoteMcpGrant(tx, { ...subject, ...input });
      return { connection, token };
    });
    if (!result) return reply.code(403).send({
      ok: false, error: { code: 'mcp_project_forbidden', message: '此账号无法对所选项目授予请求的权限。' },
    });
    return reply.code(201).send({ ok: true, data: result });
  });

  app.delete<{ Params: { code: string } }>(base + '/:code', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const principal = webPrincipal(request);
    if (!principal) return unauthorized(reply);
    const code = PublicCodeSchema.safeParse(request.params.code);
    const revoked = code.success && await db.transaction(async tx => {
      const [owner] = await tx.select({ id: schema.users.id }).from(schema.users)
        .where(eq(schema.users.code, principal)).limit(1).for('share');
      if (!owner) return false;
      const [connection] = await tx.select({ id: grants.id, revokedAt: grants.revoked_at }).from(grants)
        .where(and(eq(grants.code, code.data), eq(grants.principal_id, owner.id)))
        .limit(1).for('update');
      if (!connection) return false;
      if (!connection.revokedAt) {
        const timestamp = new Date();
        await tx.update(grants).set({ revoked_at: timestamp }).where(eq(grants.id, connection.id));
        await insertAudit(tx, toAuditEvent({
          entity_type: 'remote_mcp_connection', entity_id: connection.id, principal_id: owner.id,
          base_snapshot: 0, action: 'remote_mcp.connection_revoked', payload: { connection_code: code.data },
        }, createPublicCode(), timestamp.toISOString()));
      }
      return true;
    });
    if (!revoked) return reply.code(404).send({
      ok: false, error: { code: 'mcp_connection_not_found', message: '未找到此连接。' },
    });
    return { ok: true as const, data: { code: request.params.code } };
  });
}
