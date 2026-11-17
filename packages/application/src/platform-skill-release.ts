import { and, eq } from 'drizzle-orm';
import type { SkillPackage } from '@team-synergy/contracts';
import { schema, type Db } from '@team-synergy/persistence';
import { createPublicCode } from './public-code.js';
import { normalizeSkillPackage } from './skills-content.js';

/** Stable identity across installations; team and project authors can use the same display name. */
const releaseCode = '0R3V3R53PR0J3CTD0C50';
export function platformSkillVersion(pack: SkillPackage): string {
  const entry = pack.files.find(file => file.path === 'SKILL.md');
  const markdown = Buffer.from(entry?.content_base64 ?? '', 'base64').toString('utf8').replace(/\r\n/g, '\n');
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown)?.[1] ?? '';
  const metadata = /^metadata:[ \t]*\n((?:[ \t]+[^\n]*(?:\n|$))+)/m.exec(frontmatter)?.[1] ?? '';
  const version = /^ {2}version:[ \t]*(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})[ \t]*$/m.exec(metadata);
  if (!version) throw new Error('平台内置技能必须声明 metadata.version（主版本.次版本.修订号）');
  return version.slice(1).join('.');
}

/** Called only by the release bootstrap. No HTTP endpoint accepts an author or platform scope. */
export async function ensurePlatformSkillRelease(db: Db, bundle: SkillPackage) {
  const pack = normalizeSkillPackage(bundle.files);
  if (pack.name !== 'reverse-project-docs' || pack.name !== bundle.name || pack.package_sha256 !== bundle.package_sha256 ||
      pack.size_bytes !== bundle.size_bytes || pack.description !== bundle.description) throw new Error('平台内置技能包摘要或元数据不一致');
  const version = platformSkillVersion(pack);
  return db.transaction(async tx => {
    const timestamp = new Date().toISOString();
    await tx.insert(schema.skills).values({ code: releaseCode, scope_type: 'platform', current_revision: 1,
      created_at: timestamp, updated_at: timestamp }).onConflictDoNothing({ target: schema.skills.code });
    const [skill] = await tx.select().from(schema.skills).where(eq(schema.skills.code, releaseCode)).for('update');
    if (!skill || skill.scope_type !== 'platform') throw new Error('平台内置技能编码已被其他来源占用');
    const [stored] = await tx.select().from(schema.skillRevisions).where(and(eq(schema.skillRevisions.skill_id, skill.id), eq(schema.skillRevisions.release_version, version)));
    if (stored) {
      if ((JSON.parse(stored.package_json) as SkillPackage).package_sha256 !== pack.package_sha256) throw new Error('已发布平台技能版本的内容已改变，请更新发布版本。');
      return { skill_code: skill.code, revision: stored.revision, release_version: version };
    }
    const [current] = await tx.select().from(schema.skillRevisions).where(and(eq(schema.skillRevisions.skill_id, skill.id), eq(schema.skillRevisions.revision, skill.current_revision)));
    if (current?.release_version) {
      const previous = current.release_version.split('.').map(Number);
      const next = version.split('.').map(Number);
      const difference = next.map((part, index) => part - (previous[index] ?? 0)).find(part => part !== 0);
      // A rolling deployment may start an older binary against a database with a newer release.
      if (difference !== undefined && difference < 0) return { skill_code: skill.code, revision: current.revision, release_version: current.release_version };
    }
    const revision = current ? current.revision + 1 : 1;
    await tx.insert(schema.skillRevisions).values({ code: createPublicCode(), skill_id: skill.id, revision,
      package_json: JSON.stringify(pack), change_summary: `平台发布 ${version}`, release_version: version, created_at: timestamp, published_at: timestamp });
    await tx.update(schema.skills).set({ current_revision: revision, updated_at: timestamp }).where(eq(schema.skills.id, skill.id));
    return { skill_code: skill.code, revision, release_version: version };
  });
}
