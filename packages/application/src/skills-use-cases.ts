import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError, toAuditEvent } from '@team-synergy/domain';
import type { ProjectSkills, SkillCreateInput, SkillDetail, SkillInstallInput, SkillPackage, SkillReviseInput, SkillRevision, SkillScope, SkillShare, SkillShareInput, SkillSummary } from '@team-synergy/contracts';
import { assertProjectAccess, isProjectManager, resolveTeamRole, type AccessDb } from './project-access.js';
import { createPublicCode } from './public-code.js';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import { normalizeSkillPackage, skillAlias, skillInteger, skillInvalid, skillText } from './skills-content.js';
import { lockSkillReadScopes, lockSkillScope, skillByCode, skillPrincipal, skillProjectGrant, skillRevision, skillScope, skillSourceAccess, skillVisibleRevisions, type SkillRow, type SkillRevisionRow } from './skills-access.js';
import { projectSkillManifest, resolveRunSkillManifest } from './skills-run.js';

type Actor = { principalCode: string };
type Catalog = Actor & { teamCode?: string; projectCode?: string; view?: 'owned' | 'available' | 'shared'; query?: string };
export function createSkillsUseCases(db: Db) {
  async function result<T>(work: () => Promise<T>): Promise<TaskResult<T>> { try { return { ok: true, data: await work() }; } catch (error) { return fail(error); } }
  async function audit(tx: AccessDb, skill: SkillRow, principalId: bigint, action: string, payload: Record<string, unknown>) {
    await insertAudit(tx, toAuditEvent({ entity_type: 'skill', entity_id: skill.id, principal_id: principalId,
      base_snapshot: skill.current_revision, action, payload }, createPublicCode(), now()));
  }
  async function author(tx: AccessDb, skill: SkillRow, principalId: bigint, manage = false) {
    const access = await skillSourceAccess(tx, skill, principalId);
    if (manage ? !access.manage : !access.write || (!access.manage && skill.owner_principal_id !== principalId)) throw new DomainError('skill_forbidden', '当前身份没有技能维护权限');
    return access;
  }
  async function locked(tx: AccessDb, code: string, principalId: bigint, manage = false) {
    const initial = await skillByCode(tx, code);
    await lockSkillScope(tx, initial.scope_type, initial.scope_id, principalId);
    const [skill] = await tx.select().from(schema.skills).where(eq(schema.skills.id, initial.id)).for('update');
    if (!skill) throw new DomainError('skill_not_found', '技能不存在');
    await author(tx, skill, principalId, manage); return skill;
  }
  async function revisionDto(tx: AccessDb, revision: SkillRevisionRow): Promise<SkillRevision> {
    const [user] = await tx.select({ code: schema.users.code }).from(schema.users).where(eq(schema.users.id, revision.created_by)).limit(1);
    return { ...JSON.parse(revision.package_json) as SkillPackage, revision: revision.revision, change_summary: revision.change_summary,
      created_at: revision.created_at, created_by_user_code: user?.code ?? '', published_at: revision.published_at };
  }
  async function summary(tx: AccessDb, skill: SkillRow, principalId: bigint, visible: SkillRevisionRow[]): Promise<SkillSummary> {
    const ordered = visible.slice().sort((a, b) => b.revision - a.revision); const latest = ordered[0];
    if (!latest) throw new DomainError('skill_forbidden', '当前范围没有可访问的技能版本');
    const content = JSON.parse(latest.package_json) as SkillPackage;
    const source = await skillSourceAccess(tx, skill, principalId);
    const [owner] = await tx.select({ code: schema.users.code }).from(schema.users).where(eq(schema.users.id, skill.owner_principal_id)).limit(1);
    return { code: skill.code, scope_type: skill.scope_type, scope_code: source.code, name: content.name, description: content.description,
      current_revision: latest.revision, published_revision: ordered.find(row => row.published_at)?.revision ?? null,
      archived: skill.archived, updated_at: latest.created_at, owner_user_code: owner?.code ?? '',
      can_edit: !skill.archived && source.write && (source.manage || skill.owner_principal_id === principalId), can_manage: source.manage,
      available_revisions: ordered.filter(row => !!row.published_at).map(row => row.revision) };
  }
  async function shareDto(tx: AccessDb, row: typeof schema.skillShares.$inferSelect): Promise<SkillShare> {
    const table = row.target_type === 'team' ? schema.teams : schema.projects;
    const [target] = await tx.select({ code: table.code }).from(table).where(eq(table.id, row.target_id)).limit(1);
    return { code: row.code, target_type: row.target_type, target_code: target?.code ?? '', revisions: JSON.parse(row.revisions_json),
      allow_projects: row.allow_projects, allow_external: row.allow_external, created_at: row.created_at, revoked_at: row.revoked_at };
  }
  async function detail(tx: AccessDb, code: string, principalId: bigint, projectCode?: string): Promise<SkillDetail> {
    const skill = await skillByCode(tx, code);
    const visible = (await skillVisibleRevisions(tx, skill, principalId, projectCode)).sort((a, b) => b.revision - a.revision);
    const meta = await summary(tx, skill, principalId, visible);
    const shares = meta.can_manage ? await tx.select().from(schema.skillShares).where(eq(schema.skillShares.skill_id, skill.id)).orderBy(desc(schema.skillShares.created_at)) : [];
    const revisions: SkillRevision[] = []; const grants: SkillShare[] = [];
    for (const row of visible) revisions.push(await revisionDto(tx, row));
    for (const row of shares) grants.push(await shareDto(tx, row));
    return { ...meta, revisions, shares: grants };
  }
  function getSkill(cmd: Actor & { code: string; projectCode?: string }) {
    return result(async () => { const principal = await skillPrincipal(db, cmd.principalCode); return db.transaction(async tx => {
      const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, principal.id)).for('share');
      if (!user || user.status !== 'active' || user.deleted_at) throw new DomainError('skill_forbidden', '当前身份不能访问技能库');
      const initial = await skillByCode(tx, cmd.code);
      await lockSkillReadScopes(tx, initial, principal.id, cmd.projectCode);
      await tx.select({ id: schema.skills.id }).from(schema.skills).where(eq(schema.skills.code, cmd.code)).for('share');
      return detail(tx, cmd.code, principal.id, cmd.projectCode);
    }); });
  }
  function listSkills(cmd: Catalog) {
    return result(async () => {
      const principal = await skillPrincipal(db, cmd.principalCode);
      if (!!cmd.teamCode === !!cmd.projectCode) skillInvalid('请选择一个团队或项目范围');
      const type: SkillScope = cmd.teamCode ? 'team' : 'project';
      const scope = await skillScope(db, type, cmd.teamCode ?? cmd.projectCode ?? '');
      const view = cmd.view ?? 'owned'; if (!['owned', 'available', 'shared'].includes(view)) skillInvalid('无效的技能库视图');
      if (type === 'team') {
        if (!await resolveTeamRole(db, scope.id, principal.id)) throw new DomainError('skill_forbidden', '只有团队成员可以查看团队技能库');
      } else await assertProjectAccess(db, scope.id, principal.id);
      const skills = await db.select().from(schema.skills).orderBy(desc(schema.skills.updated_at)); const output: SkillSummary[] = [];
      const [project] = type === 'project' ? await db.select().from(schema.projects).where(eq(schema.projects.id, scope.id)).limit(1) : [];
      for (const skill of skills) {
        const own = skill.scope_type === type && skill.scope_id === scope.id;
        if ((view === 'owned' && !own) || (view === 'shared' && own)) continue;
        let visible = await skillVisibleRevisions(db, skill, principal.id, cmd.projectCode);
        if (!own) {
          if (project) {
            const access = await assertProjectAccess(db, project.id, principal.id);
            const [install] = await db.select().from(schema.projectSkillInstallations).where(and(eq(schema.projectSkillInstallations.project_id, project.id), eq(schema.projectSkillInstallations.skill_id, skill.id))).limit(1);
            const eligible: SkillRevisionRow[] = [];
            for (const rev of visible) if ((isProjectManager(access.role) || install?.revision === rev.revision) && await skillProjectGrant(db, skill, rev, project)) eligible.push(rev);
            visible = eligible;
          } else {
            const shares = await db.select().from(schema.skillShares).where(and(eq(schema.skillShares.skill_id, skill.id), eq(schema.skillShares.target_type, type), eq(schema.skillShares.target_id, scope.id), isNull(schema.skillShares.revoked_at)));
            const allowed = new Set(shares.flatMap(row => JSON.parse(row.revisions_json) as number[]));
            visible = visible.filter(rev => !skill.archived && !!rev.published_at && allowed.has(rev.revision));
          }
        }
        if (!visible.length) continue;
        const item = await summary(db, skill, principal.id, visible);
        if (cmd.query && !`${item.code} ${item.name} ${item.description}`.toLowerCase().includes(cmd.query.trim().toLowerCase())) continue;
        output.push(item);
      }
      return output;
    });
  }
  function createSkill(cmd: Actor & { input: SkillCreateInput }) {
    return result(async () => {
      const principal = await skillPrincipal(db, cmd.principalCode); const pack = normalizeSkillPackage(cmd.input.files);
      const scope = await skillScope(db, cmd.input.scope_type, cmd.input.scope_code);
      return db.transaction(async tx => {
        await lockSkillScope(tx, scope.type, scope.id, principal.id);
        const access = await skillSourceAccess(tx, { scope_type: scope.type, scope_id: scope.id }, principal.id);
        if (!access.write) throw new DomainError('skill_forbidden', '当前范围不能创建技能');
        const timestamp = now(); const [skill] = await tx.insert(schema.skills).values({ code: createPublicCode(), scope_type: scope.type,
          scope_id: scope.id, owner_principal_id: principal.id, current_revision: 1, archived: false, created_at: timestamp, updated_at: timestamp }).returning();
        if (!skill) throw new DomainError('internal_error', '技能创建失败');
        await tx.insert(schema.skillRevisions).values({ skill_id: skill.id, revision: 1, package_json: JSON.stringify(pack),
          change_summary: cmd.input.change_summary ? skillText(cmd.input.change_summary, '变更说明') : '初始草稿', created_by: principal.id, created_at: timestamp });
        await audit(tx, skill, principal.id, 'skill.created', { revision: 1, package_sha256: pack.package_sha256 });
        return detail(tx, skill.code, principal.id);
      });
    });
  }
  function reviseSkill(cmd: Actor & { code: string; input: SkillReviseInput }) {
    return result(async () => {
      const principal = await skillPrincipal(db, cmd.principalCode); const pack = normalizeSkillPackage(cmd.input.files);
      skillInteger(cmd.input.base_revision); const change = skillText(cmd.input.change_summary, '变更说明');
      return db.transaction(async tx => {
        const skill = await locked(tx, cmd.code, principal.id);
        if (skill.archived) throw new DomainError('skill_archived', '已归档技能不能修改');
        if (skill.current_revision !== cmd.input.base_revision) throw new DomainError('skill_revision_conflict', '技能已更新，请重新加载后合并');
        const timestamp = now(); const revision = skill.current_revision + 1;
        await tx.insert(schema.skillRevisions).values({ skill_id: skill.id, revision, package_json: JSON.stringify(pack), change_summary: change, created_by: principal.id, created_at: timestamp });
        await tx.update(schema.skills).set({ current_revision: revision, updated_at: timestamp }).where(eq(schema.skills.id, skill.id));
        await audit(tx, skill, principal.id, 'skill.revised', { revision, package_sha256: pack.package_sha256, change_summary: change });
        return detail(tx, skill.code, principal.id);
      });
    });
  }
  function publishSkill(cmd: Actor & { code: string; revision: number }) {
    return result(async () => {
      const principal = await skillPrincipal(db, cmd.principalCode); skillInteger(cmd.revision);
      return db.transaction(async tx => {
        const skill = await locked(tx, cmd.code, principal.id, true);
        if (skill.archived) throw new DomainError('skill_archived', '已归档技能不能发布');
        const rev = await skillRevision(tx, skill.id, cmd.revision);
        if (!rev.published_at) {
          await tx.update(schema.skillRevisions).set({ published_at: now() }).where(eq(schema.skillRevisions.id, rev.id));
          await audit(tx, skill, principal.id, 'skill.published', { revision: rev.revision });
        }
        return detail(tx, skill.code, principal.id);
      });
    });
  }
  function archiveSkill(cmd: Actor & { code: string; archived: boolean }) {
    return result(async () => {
      const principal = await skillPrincipal(db, cmd.principalCode); if (typeof cmd.archived !== 'boolean') skillInvalid('归档状态无效');
      return db.transaction(async tx => {
        const skill = await locked(tx, cmd.code, principal.id, true);
        await tx.update(schema.skills).set({ archived: cmd.archived, updated_at: now() }).where(eq(schema.skills.id, skill.id));
        await audit(tx, skill, principal.id, cmd.archived ? 'skill.archived' : 'skill.unarchived', {});
        return detail(tx, skill.code, principal.id);
      });
    });
  }
  function shareSkill(cmd: Actor & { code: string; input: SkillShareInput }) {
    return result(async () => {
      const principal = await skillPrincipal(db, cmd.principalCode); const input = cmd.input;
      if (!Array.isArray(input.revisions) || !input.revisions.length || input.revisions.length > 200) skillInvalid('共享必须指定确切的版本列表');
      const revisions = [...new Set(input.revisions.map(value => skillInteger(value)))].sort((a, b) => a - b);
      for (const field of ['allow_projects', 'allow_external'] as const) if (input[field] !== undefined && typeof input[field] !== 'boolean') skillInvalid('共享范围必须使用布尔值');
      const target = await skillScope(db, input.target_type, input.target_code);
      return db.transaction(async tx => {
        const skill = await locked(tx, cmd.code, principal.id, true);
        if (skill.archived) throw new DomainError('skill_archived', '已归档技能不能共享');
        if (skill.scope_type === target.type && skill.scope_id === target.id) skillInvalid('无需共享到技能自身范围');
        for (const version of revisions) if (!(await skillRevision(tx, skill.id, version)).published_at) skillInvalid('只能共享已发布版本');
        const existing = await tx.select().from(schema.skillShares).where(and(eq(schema.skillShares.skill_id, skill.id), eq(schema.skillShares.target_type, target.type), eq(schema.skillShares.target_id, target.id), isNull(schema.skillShares.revoked_at)));
        if (existing.some(share => share.revisions_json === JSON.stringify(revisions) && share.allow_projects === (input.allow_projects ?? false) && share.allow_external === (input.allow_external ?? false))) return detail(tx, skill.code, principal.id);
        const [share] = await tx.insert(schema.skillShares).values({ skill_id: skill.id, target_type: target.type, target_id: target.id,
          revisions_json: JSON.stringify(revisions), allow_projects: input.allow_projects ?? false, allow_external: input.allow_external ?? false,
          created_by: principal.id, created_at: now() }).returning();
        await audit(tx, skill, principal.id, 'skill.shared', { share_code: share?.code, target_type: target.type, target_code: target.code, revisions,
          allow_projects: input.allow_projects ?? false, allow_external: input.allow_external ?? false });
        return detail(tx, skill.code, principal.id);
      });
    });
  }
  function revokeShare(cmd: Actor & { code: string; shareCode: string }) {
    return result(async () => {
      const principal = await skillPrincipal(db, cmd.principalCode);
      return db.transaction(async tx => {
        const skill = await locked(tx, cmd.code, principal.id, true);
        const [share] = await tx.select().from(schema.skillShares).where(and(eq(schema.skillShares.code, cmd.shareCode), eq(schema.skillShares.skill_id, skill.id))).limit(1);
        if (!share) throw new DomainError('skill_share_not_found', '共享授权不存在');
        if (!share.revoked_at) {
          await tx.update(schema.skillShares).set({ revoked_at: now(), revoked_by: principal.id }).where(eq(schema.skillShares.id, share.id));
          await audit(tx, skill, principal.id, 'skill.share_revoked', { share_code: share.code });
        }
        return detail(tx, skill.code, principal.id);
      });
    });
  }
  async function projectFor(tx: AccessDb, projectCode: string, principalId: bigint) {
    const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.code, projectCode)).limit(1);
    if (!project) throw new DomainError('project_not_found', '项目不存在');
    const access = await assertProjectAccess(tx, project.id, principalId); return { project, access };
  }
  async function installations(tx: AccessDb, projectCode: string, principalId: bigint): Promise<ProjectSkills> {
    const { project, access } = await projectFor(tx, projectCode, principalId);
    const [state] = await tx.select().from(schema.projectSkillStates).where(eq(schema.projectSkillStates.project_id, project.id)).limit(1);
    const installs = await tx.select().from(schema.projectSkillInstallations).where(eq(schema.projectSkillInstallations.project_id, project.id)).orderBy(schema.projectSkillInstallations.alias);
    const output: ProjectSkills['installations'] = [];
    for (const install of installs) {
      const [skill] = await tx.select().from(schema.skills).where(eq(schema.skills.id, install.skill_id)).limit(1);
      if (!skill) continue;
      const revision = await skillRevision(tx, skill.id, install.revision); const pack = JSON.parse(revision.package_json) as SkillPackage;
      const source = await skillSourceAccess(tx, skill, principalId); const allowed = await skillProjectGrant(tx, skill, revision, project);
      const available: number[] = [];
      // Ordinary readers see only the installed revision. Only project managers can discover authorized upgrades.
      if (isProjectManager(access.role)) {
        const revisions = await tx.select().from(schema.skillRevisions).where(eq(schema.skillRevisions.skill_id, skill.id));
        for (const rev of revisions) if (await skillProjectGrant(tx, skill, rev, project)) available.push(rev.revision);
      } else if (allowed) available.push(revision.revision);
      output.push({ skill_code: skill.code, revision: revision.revision, alias: install.alias, enabled: install.enabled,
        name: install.alias, description: allowed ? pack.description : '', scope_type: skill.scope_type, scope_code: source.code,
        package_sha256: pack.package_sha256, available_revisions: available.sort((a, b) => b - a), blocked: !allowed,
        blocked_reason: allowed ? null : '技能已归档、共享已撤销或项目包含未授权的外部成员' });
    }
    return { project_code: project.code, generation: state?.generation ?? 0, can_manage: isProjectManager(access.role) && project.status === 'active', installations: output };
  }
  function listProjectSkills(cmd: Actor & { projectCode: string }) {
    return result(async () => { const principal = await skillPrincipal(db, cmd.principalCode); return db.transaction(tx => installations(tx, cmd.projectCode, principal.id)); });
  }
  function installSkill(cmd: Actor & { projectCode: string; code: string; input: SkillInstallInput }) {
    return result(async () => {
      const principal = await skillPrincipal(db, cmd.principalCode); const input = cmd.input;
      const revision = skillInteger(input.revision); const generation = skillInteger(input.base_generation, 0); const alias = skillAlias(input.alias);
      if (typeof input.enabled !== 'boolean') skillInvalid('必须明确启用或停用状态');
      return db.transaction(async tx => {
        const initialProject = (await projectFor(tx, cmd.projectCode, principal.id)).project;
        await lockSkillScope(tx, 'project', initialProject.id, principal.id); await assertProjectAccess(tx, initialProject.id, principal.id, 'manage');
        const { project } = await projectFor(tx, cmd.projectCode, principal.id);
        await tx.insert(schema.projectSkillStates).values({ project_id: project.id, generation: 0 }).onConflictDoNothing();
        const [state] = await tx.select().from(schema.projectSkillStates).where(eq(schema.projectSkillStates.project_id, project.id)).for('update');
        if (!state || state.generation !== generation) throw new DomainError('skill_generation_conflict', '项目技能列表已更新，请重新加载');
        const initial = await skillByCode(tx, cmd.code);
        const [skill] = await tx.select().from(schema.skills).where(eq(schema.skills.id, initial.id)).for('share');
        if (!skill) throw new DomainError('skill_not_found', '技能不存在');
        const [existing] = await tx.select().from(schema.projectSkillInstallations).where(and(eq(schema.projectSkillInstallations.project_id, project.id), eq(schema.projectSkillInstallations.skill_id, skill.id))).limit(1);
        const rev = await skillRevision(tx, skill.id, revision);
        // A revoked installation can be disabled, but this does not permit selecting another hidden version.
        const disabling = existing && !input.enabled && revision === existing.revision && alias === existing.alias;
        if (!disabling && !await skillProjectGrant(tx, skill, rev, project)) throw new DomainError('skill_delivery_blocked', '此版本未获准向当前项目及其成员交付');
        const [collision] = await tx.select().from(schema.projectSkillInstallations).where(and(eq(schema.projectSkillInstallations.project_id, project.id), eq(schema.projectSkillInstallations.alias, alias))).limit(1);
        if (collision && collision.skill_id !== skill.id) throw new DomainError('skill_alias_conflict', '项目已使用该别名，请指定另一个名称');
        await tx.insert(schema.projectSkillInstallations).values({ project_id: project.id, skill_id: skill.id, revision, alias, enabled: input.enabled, updated_by: principal.id, updated_at: now() })
          .onConflictDoUpdate({ target: [schema.projectSkillInstallations.project_id, schema.projectSkillInstallations.skill_id], set: { revision, alias, enabled: input.enabled, updated_by: principal.id, updated_at: now() } });
        await tx.update(schema.projectSkillStates).set({ generation: generation + 1 }).where(eq(schema.projectSkillStates.project_id, project.id));
        await audit(tx, skill, principal.id, 'skill.installation_updated', { project_code: project.code, revision, alias, enabled: input.enabled, generation: generation + 1 });
        return installations(tx, project.code, principal.id);
      });
    });
  }
  function getProjectManifest(cmd: Actor & { projectCode: string }) {
    return result(async () => { const principal = await skillPrincipal(db, cmd.principalCode); return db.transaction(async tx => {
      const { project } = await projectFor(tx, cmd.projectCode, principal.id); return projectSkillManifest(tx, project.id, principal.id);
    }); });
  }
  function getRunManifest(cmd: Actor & { runCode: string }) {
    return result(async () => { const principal = await skillPrincipal(db, cmd.principalCode); return db.transaction(async tx => {
      const [run] = await tx.select().from(schema.runs).where(eq(schema.runs.code, cmd.runCode)).limit(1);
      if (!run) throw new DomainError('run_not_found', 'Run 不存在');
      return resolveRunSkillManifest(tx, { runId: run.id, principalId: principal.id });
    }); });
  }
  return { listSkills, getSkill, createSkill, reviseSkill, publishSkill, archiveSkill, shareSkill, revokeShare, listProjectSkills, installSkill, getProjectManifest, getRunManifest };
}
