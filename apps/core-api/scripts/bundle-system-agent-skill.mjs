import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SYSTEM_AGENT_GUIDANCE_MAX_CHARACTERS, SYSTEM_AGENT_GUIDANCE_MAX_SERIALIZED_BYTES } from '../dist/system-agent-guidance.js';

const skillRoot = new URL('../../../skills/spec-production/', import.meta.url);

/** Include local reference closure: the restricted document Agent cannot open linked files. */
export function buildSystemAgentSkill(source = skillRoot) {
  const root = realpathSync(source);
  const files = new Map();
  const visit = relative => {
    if (!/^(?:SKILL\.md|references\/[\w.-]+\.(?:md|json))$/.test(relative)) throw new Error(`Unsupported Skill reference: ${relative}`);
    if (files.has(relative)) return;
    const file = path.resolve(root, relative);
    if (realpathSync(file) !== file) throw new Error(`Skill reference must not use links: ${relative}`);
    const content = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    files.set(relative, content);
    for (const match of content.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
      if (target.startsWith('/') || target.includes('\\')) throw new Error(`Unsupported Skill reference: ${target}`);
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), target)));
    }
  };
  visit('SKILL.md');
  const version = files.get('SKILL.md').match(/^\s+version:\s*(.+)$/m)?.[1]?.trim();
  if (!version) throw new Error('spec-production Skill version is missing');
  const guidance = [...files].sort(([a], [b]) => a === b ? 0 : a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a < b ? -1 : 1)
    .map(([relative, content]) => `--- ${relative} ---\n${content}`).join('\n\n');
  if (guidance.length > SYSTEM_AGENT_GUIDANCE_MAX_CHARACTERS || Buffer.byteLength(JSON.stringify(guidance), 'utf8') > SYSTEM_AGENT_GUIDANCE_MAX_SERIALIZED_BYTES) throw new Error('System Agent guidance exceeds the bounded context limit');
  return { version, sha256: createHash('sha256').update(guidance).digest('hex'), guidance };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const bundle = buildSystemAgentSkill();
  const output = new URL('../dist/system-agent-skill.json', import.meta.url);
  mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
  writeFileSync(output, JSON.stringify(bundle));
  console.log(`System Agent Skill ${bundle.version} bundled: ${fileURLToPath(output)}`);
}
