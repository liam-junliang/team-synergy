import { eq } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError, toAuditEvent } from '@team-synergy/domain';
import { codeCondition, createPublicCode } from './public-code.js';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';

type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
type SettingsRow = typeof schema.systemSettings.$inferSelect;

export interface SystemSettingsView {
  public_web_url: string | null;
  public_api_url: string | null;
  revision: number;
  updated_at: string | null;
  updated_by: string | null;
}

function normalizedUrl(input: unknown, field: 'public_web_url' | 'public_api_url'): string | null {
  if (input === null || input === '') return null;
  const invalid = () => new DomainError('settings_url_invalid', `${field} 必须是无账号密码、查询参数和片段的 HTTPS 地址；本机调试允许 HTTP`, { field });
  // Reject control characters before trimming: URL() silently removes some of them.
  if (typeof input !== 'string' || input.length > 2048 || input.includes('\\') || [...input].some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) throw invalid();
  const value = input.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value) || /[\s'"`$;&|<>]/.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || value.includes('?') || value.includes('#')) throw invalid();
  if (field === 'public_web_url' && url.pathname !== '/') {
    throw new DomainError('settings_url_invalid', 'Web 地址只支持站点根地址，不能包含路径', { field });
  }
  // Restrict API paths to ordinary URL path segments. In particular, commands
  // rendered by clients must never acquire shell syntax from configuration.
  if (!/^\/(?:[A-Za-z0-9._~%-]+\/?)*$/.test(url.pathname) || /%(?![0-9a-f]{2})|%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c)/i.test(url.pathname)) throw invalid();
  const normalized = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  if (!/^https?:\/\/[A-Za-z0-9._~:/%[\]-]+$/.test(normalized)) throw invalid();
  return normalized;
}

async function actor(db: Db | DbTx, principalCode: string, admin: boolean, lock = false) {
  const condition = codeCondition(schema.users, principalCode);
  if (!condition) throw new DomainError('settings_forbidden', '无权访问系统配置');
  const query = db.select().from(schema.users).where(condition).limit(1);
  const [user] = await (lock ? query.for('share') : query);
  if (!user || user.status !== 'active' || (admin && (!user.is_system_admin || user.pending_deletion || user.deleted_at))) throw new DomainError('settings_forbidden', '只有系统管理员可以管理系统配置');
  return user;
}

async function settingsView(db: Db | DbTx, row: SettingsRow | undefined): Promise<SystemSettingsView> {
  const [updater] = row?.updated_by
    ? await db.select({ code: schema.users.code }).from(schema.users).where(eq(schema.users.id, row.updated_by)).limit(1)
    : [];
  return {
    public_web_url: row?.public_web_url ?? null,
    public_api_url: row?.public_api_url ?? null,
    revision: row?.revision ?? 0,
    updated_at: row?.updated_at ?? null,
    updated_by: updater?.code ?? null,
  };
}

export function createSystemSettingsUseCases(db: Db) {
  async function getSettings(principalCode: string): Promise<TaskResult<SystemSettingsView>> {
    try {
      await actor(db, principalCode, true);
      const [row] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.id, 1)).limit(1);
      return { ok: true, data: await settingsView(db, row) };
    } catch (error) { return fail(error); }
  }

  async function clientConfig(principalCode: string): Promise<TaskResult<Pick<SystemSettingsView, 'public_web_url' | 'public_api_url'>>> {
    try {
      await actor(db, principalCode, false);
      const [row] = await db.select({ public_web_url: schema.systemSettings.public_web_url, public_api_url: schema.systemSettings.public_api_url }).from(schema.systemSettings).where(eq(schema.systemSettings.id, 1)).limit(1);
      return { ok: true, data: row ?? { public_web_url: null, public_api_url: null } };
    } catch (error) { return fail(error); }
  }

  async function updateSettings(principalCode: string, input: unknown): Promise<TaskResult<SystemSettingsView>> {
    try {
      const data = await db.transaction(async tx => {
        const admin = await actor(tx, principalCode, true, true);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('settings_input_invalid', '需要完整的系统配置');
        const body = input as Record<string, unknown>;
        if (Object.keys(body).some(key => !['public_web_url', 'public_api_url', 'base_revision'].includes(key)) || !Number.isSafeInteger(body.base_revision) || (body.base_revision as number) < 0 || !Object.hasOwn(body, 'public_web_url') || !Object.hasOwn(body, 'public_api_url')) {
          throw new DomainError('settings_input_invalid', '需要两个公开地址和有效的 base_revision');
        }
        const urls = { public_web_url: normalizedUrl(body.public_web_url, 'public_web_url'), public_api_url: normalizedUrl(body.public_api_url, 'public_api_url') };
        // Also handles a fresh test database that has been truncated after migration.
        await tx.insert(schema.systemSettings).values({ id: 1 }).onConflictDoNothing();
        const [current] = await tx.select().from(schema.systemSettings).where(eq(schema.systemSettings.id, 1)).for('update').limit(1);
        if (!current) throw new DomainError('internal_error', '系统配置不存在');
        if (current.revision !== body.base_revision) throw new DomainError('settings_revision_conflict', '系统配置已更新，请刷新后重试', { current_revision: current.revision });
        if (current.public_web_url === urls.public_web_url && current.public_api_url === urls.public_api_url) return settingsView(tx, current);
        const timestamp = now();
        const [updated] = await tx.update(schema.systemSettings).set({ ...urls, revision: current.revision + 1, updated_at: timestamp, updated_by: admin.id }).where(eq(schema.systemSettings.id, 1)).returning();
        await insertAudit(tx, toAuditEvent({
          entity_type: 'system_settings', entity_id: 1n, principal_id: admin.id,
          base_snapshot: current.revision, action: 'system_settings.updated',
          payload: {
            before: { public_web_url: current.public_web_url, public_api_url: current.public_api_url },
            after: urls, revision: current.revision + 1,
          },
        }, createPublicCode(), timestamp));
        return settingsView(tx, updated);
      });
      return { ok: true, data };
    } catch (error) { return fail(error); }
  }

  return { getSettings, updateSettings, clientConfig };
}
