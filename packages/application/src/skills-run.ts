import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import type { ProjectSkillManifest, RunSkillManifest, SkillPackage } from '@team-synergy/contracts';
import { assertProjectAccess, type AccessDb } from './project-access.js';
import { skillByCode, skillProjectGrant, skillRevision, skillSourceAccess } from './skills-access.js';

async function projectOf(db: AccessDb, projectId: bigint, principalId: bigint) {
  await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, principalId)).for('share');
  const [initial] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  if (!initial) throw new DomainError('project_not_found', '项目不存在');
  await db.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, initial.team_id)).for('share');
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).for('share');
  if (!project) throw new DomainError('project_not_found', '项目不存在');
  await assertProjectAccess(db, projectId, principalId);
  return project;
}
export async function projectSkillManifest(db: AccessDb, projectId: bigint, principalId: bigint): Promise<ProjectSkillManifest> {
  const project = await projectOf(db, projectId, principalId);
  // Installation writers hold the project row exclusively for the entire generation update.
  await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).for('share');
  const [state] = await db.select().from(schema.projectSkillStates).where(eq(schema.projectSkillStates.project_id, projectId)).limit(1);
  const installs = await db.select().from(schema.projectSkillInstallations).where(and(eq(schema.projectSkillInstallations.project_id, projectId), eq(schema.projectSkillInstallations.enabled, true))).orderBy(schema.projectSkillInstallations.alias);
  const skills: ProjectSkillManifest['skills'] = [];
  for (const install of installs) {
    const [skill] = await db.select().from(schema.skills).where(eq(schema.skills.id, install.skill_id)).for('share');
    if (!skill) throw new DomainError('skill_delivery_blocked', '项目引用的技能不存在');
    const rev = await skillRevision(db, skill.id, install.revision);
    if (!await skillProjectGrant(db, skill, rev, project)) throw new DomainError('skill_delivery_blocked', '技能已归档、共享已撤销或项目包含未授权的外部成员', { skill_code: skill.code });
    const pack = JSON.parse(rev.package_json) as SkillPackage;
    const source = await skillSourceAccess(db, skill, principalId);
    skills.push({ skill_code: skill.code, revision: rev.revision, alias: install.alias, name: pack.name, description: pack.description,
      scope_type: skill.scope_type, scope_code: source.code, package_sha256: pack.package_sha256, files: pack.files });
  }
  return { project_code: project.code, generation: state?.generation ?? 0, skills };
}
export function skillManifestMetadata(manifest: ProjectSkillManifest): RunSkillManifest {
  return { project_code: manifest.project_code, generation: manifest.generation,
    skills: manifest.skills.map(({ files: _files, ...entry }) => entry) };
}
export async function captureRunSkills(db: AccessDb, cmd: { projectId: bigint; principalId: bigint; runId: bigint }): Promise<RunSkillManifest> {
  const manifest = skillManifestMetadata(await projectSkillManifest(db, cmd.projectId, cmd.principalId));
  const [saved] = await db.select().from(schema.runSkillManifests).where(eq(schema.runSkillManifests.run_id, cmd.runId)).limit(1);
  if (saved) throw new DomainError('skill_revision_conflict', 'Run 的技能快照已经固定');
  await db.insert(schema.runSkillManifests).values({ run_id: cmd.runId, manifest_json: JSON.stringify(manifest), created_at: new Date().toISOString() });
  return manifest;
}
async function runProject(db: AccessDb, runId: bigint) {
  const [row] = await db.select({ projectId: schema.features.project_id }).from(schema.runs)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.runs.task_id))
    .innerJoin(schema.features, eq(schema.features.id, schema.tasks.feature_id)).where(eq(schema.runs.id, runId)).limit(1);
  if (!row) throw new DomainError('run_not_found', 'Run 不存在');
  return row.projectId;
}
/** Legacy runs intentionally resolve to an empty manifest, never today's installations. */
export async function resolveRunSkillManifest(db: AccessDb, cmd: { runId: bigint; principalId: bigint }): Promise<ProjectSkillManifest> {
  const projectId = await runProject(db, cmd.runId);
  const project = await projectOf(db, projectId, cmd.principalId);
  const [saved] = await db.select().from(schema.runSkillManifests).where(eq(schema.runSkillManifests.run_id, cmd.runId)).limit(1);
  const manifest: RunSkillManifest = saved ? JSON.parse(saved.manifest_json) : { project_code: project.code, generation: 0, skills: [] };
  if (manifest.project_code !== project.code) throw new DomainError('skill_delivery_blocked', 'Run 技能范围不一致');
  const skills: ProjectSkillManifest['skills'] = [];
  for (const entry of manifest.skills) {
    const initial = await skillByCode(db, entry.skill_code);
    const [skill] = await db.select().from(schema.skills).where(eq(schema.skills.id, initial.id)).for('share');
    if (!skill) throw new DomainError('skill_delivery_blocked', '技能不存在');
    const revision = await skillRevision(db, skill.id, entry.revision);
    if (!await skillProjectGrant(db, skill, revision, project)) throw new DomainError('skill_delivery_blocked', 'Run 固定的技能版本已失去当前授权', { skill_code: skill.code });
    const pack = JSON.parse(revision.package_json) as SkillPackage;
    if (entry.package_sha256 !== pack.package_sha256) throw new DomainError('skill_delivery_blocked', 'Run 技能摘要校验失败');
    skills.push({ ...entry, files: pack.files });
  }
  return { ...manifest, skills };
}
export async function copyRunSkills(db: AccessDb, cmd: { sourceRunId: bigint; targetRunId: bigint; projectId: bigint; principalId: bigint }): Promise<RunSkillManifest> {
  const project = await projectOf(db, cmd.projectId, cmd.principalId);
  if (await runProject(db, cmd.sourceRunId) !== cmd.projectId || await runProject(db, cmd.targetRunId) !== cmd.projectId) throw new DomainError('skill_forbidden', 'Run 技能不能跨项目复制');
  const manifest = skillManifestMetadata(await resolveRunSkillManifest(db, { runId: cmd.sourceRunId, principalId: cmd.principalId }));
  if (manifest.project_code !== project.code) throw new DomainError('skill_forbidden', 'Run 技能范围不一致');
  const [saved] = await db.select().from(schema.runSkillManifests).where(eq(schema.runSkillManifests.run_id, cmd.targetRunId)).limit(1);
  if (saved) throw new DomainError('skill_revision_conflict', '目标 Run 技能快照已经固定');
  await db.insert(schema.runSkillManifests).values({ run_id: cmd.targetRunId, manifest_json: JSON.stringify(manifest), created_at: new Date().toISOString() });
  return manifest;
}
