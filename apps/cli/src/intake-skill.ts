import { readFileSync } from 'node:fs';
import { INTAKE_SKILL_VERSION, type IntakeProfile } from '@team-synergy/contracts';

type SkillBundle = { text: string; references: Record<string, string> };

/** The build bundles canonical resources; installed clients never need the source repository. */
function bundledSkill(): SkillBundle {
  try {
    const bundle: SkillBundle = JSON.parse(readFileSync(new URL('./spec-production.json', import.meta.url), 'utf8'));
    if (typeof bundle.text !== 'string' || !bundle.references || typeof bundle.references !== 'object' || Array.isArray(bundle.references)) {
      throw new Error('Missing SKILL.md or references');
    }
    const version = bundle.text.match(/^ {2}version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
    if (version !== INTAKE_SKILL_VERSION) throw new Error(`Skill version ${version ?? 'missing'} does not match CLI ${INTAKE_SKILL_VERSION}`);
    for (const [name, content] of Object.entries(bundle.references)) {
      if (!/^[\w.-]+\.(md|json)$/.test(name) || typeof content !== 'string' || !content.trim()) throw new Error(`Invalid reference ${name}`);
    }
    const documents: [string, string][] = [['SKILL.md', bundle.text], ...Object.entries(bundle.references)];
    for (const [name, content] of documents) {
      for (const match of content.matchAll(/\]\(([^\s)#]+)(?:#[^)]*)?\)/g)) {
        const target = match[1];
        if (!target) continue;
        const reference = target.startsWith('references/') ? target.slice(11) : name !== 'SKILL.md' && /^[\w.-]+\.(md|json)$/.test(target) ? target : undefined;
        if (reference && !Object.hasOwn(bundle.references, reference)) throw new Error(`Missing reference ${reference} linked from ${name}`);
      }
    }
    return bundle;
  } catch (cause) {
    throw new Error(`Bundled specification skill is unavailable or invalid; rebuild or reinstall the CLI. ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export function intakeSkillText(profile: IntakeProfile = 'pilot'): string {
  const profileNote = profile === 'enterprise'
    ? 'This pack uses the enterprise profile: resolve capability and dossier blockers before publication.'
    : 'This pack uses the pilot profile: report its declared limits; do not call it a full enterprise dossier.';
  return `${bundledSkill().text.trimEnd()}\n\n${profileNote}\n`;
}

export function intakeSkillReferences(): Record<string, string> {
  return bundledSkill().references;
}
