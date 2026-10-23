import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const skillRoot = new URL('../../../skills/spec-production/', import.meta.url);
const paths = ['SKILL.md', 'references/scope.md', 'references/specification.md'];
const files = paths.map(path => ({ path, content: readFileSync(new URL(path, skillRoot), 'utf8').replace(/\r\n/g, '\n') }));
const version = files[0].content.match(/^\s+version:\s*(.+)$/m)?.[1]?.trim();
if (!version) throw new Error('spec-production Skill version is missing');
const guidance = files.map(file => `--- ${file.path} ---\n${file.content}`).join('\n\n');
if (guidance.length > 30_000 || Buffer.byteLength(JSON.stringify(guidance), 'utf8') > 40_000) throw new Error('System Agent guidance exceeds the bounded context limit');
const bundle = { version, sha256: createHash('sha256').update(guidance).digest('hex'), guidance };
const output = new URL('../dist/system-agent-skill.json', import.meta.url);
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(output, JSON.stringify(bundle));
console.log(`System Agent Skill ${version} bundled: ${fileURLToPath(output)}`);
