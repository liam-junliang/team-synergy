import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RemoteMcpToolModuleSchema } from '../dist/remote-mcp-tool-catalog.js';

const source = new URL('../../../skills/team-synergy-connector/', import.meta.url);
const target = new URL('../dist/connector-skill/', import.meta.url);
const paths = ['SKILL.md', ...RemoteMcpToolModuleSchema.options.map(module => `references/${module}.md`)];
mkdirSync(new URL('references/', target), { recursive: true });
for (const path of paths) {
  const markdown = readFileSync(new URL(path, source), 'utf8').replace(/\r\n/g, '\n');
  if (!markdown.trim() || Buffer.byteLength(markdown, 'utf8') > 8_192) throw new Error(`Connector skill document must fit within 8 KiB: ${path}`);
  if (path === 'SKILL.md' && !markdown.startsWith('---\nname: team-synergy-connector\n')) throw new Error('Connector skill name is invalid');
  writeFileSync(new URL(path, target), markdown);
}
