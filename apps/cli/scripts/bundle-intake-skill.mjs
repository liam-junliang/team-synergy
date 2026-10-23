import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

const source = new URL('../../../skills/spec-production/', import.meta.url);
const destination = new URL('../dist/spec-production.json', import.meta.url);
const references = {};
for (const entry of (await readdir(new URL('references/', source), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
  if (!entry.isFile() || !/^[\w.-]+\.(md|json)$/.test(entry.name)) throw new Error(`Unsupported specification skill reference: ${entry.name}`);
  references[entry.name] = await readFile(new URL(`references/${entry.name}`, source), 'utf8');
}
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
// Replace the whole map so deleted references cannot survive a rebuild. Evaluation fixtures stay local.
await writeFile(destination, `${JSON.stringify({ text: await readFile(new URL('SKILL.md', source), 'utf8'), references }, null, 2)}\n`);
const { intakeSkillText, intakeSkillReferences } = await import('../dist/intake-skill.js');
intakeSkillText();
intakeSkillReferences();
