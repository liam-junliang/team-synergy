import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Reuse an installed official SDK. The only upstream command available to this
// fixture is Bob's attested, loopback-bound context reader for this task.
const sdk = realpathSync(process.env.TSP_PROBE_MCP_SDK);
const load = file => import(pathToFileURL(join(sdk, 'dist/esm', file)));
const { Server } = await load('server/index.js');
const { StdioServerTransport } = await load('server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = await load('types.js');
const cli = 'F:/workspace/team-knowledge-runtime/hub/teamsynergy-study/members/bob/cli.mjs';
const server = new Server({ name: 'memory-harness-live-read', version: '1' }, { capabilities: { tools: {} } });
const tool = { name: 'search_memory', description: '使用自然语言检索当前项目和本人的经验。返回实际匹配的资料、范围、状态和来源。个人经验适用于本人，项目规范需要项目依据。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['query'], additionalProperties: false } };
const decisions = { name: 'read_project_decisions', description: '按需读取当前范围已明确确认的项目决定与规范，返回生效的原文、修订版本及出处。确认表示已采纳，实施进度需要独立依据。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
const projectOnly = process.argv[2] === 'project';
const projectReader = projectOnly ? (await import('../engines/project-reader.mjs')).readProjectFixture : undefined;
const includeDecisions = projectOnly || process.argv[2] === 'decisions';
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: includeDecisions ? [tool, decisions] : [tool] }));

function context(tail) {
  if (projectOnly) throw Error('Project-only fixture forbids the task context reader');
  const command = spawnSync(process.execPath, [cli, 'context', 'teamsynergy', 'image-preflight', ...tail], {
    encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2e6,
  });
  if (command.status !== 0) throw Error('Owned live fixture context unavailable');
  const ctx = JSON.parse(command.stdout);
  if (ctx.project?.id !== 'teamsynergy' || ctx.task?.id !== 'image-preflight') throw Error('Unexpected context scope');
  return ctx;
}

async function readProjectOnly(mode, query) {
  const result = await projectReader({ mode, query });
  const rows = result.rows.filter(row => Buffer.byteLength(row.body) <= 1536).slice(0, 4).map(row => ({
    scope: row.scope === 'self' ? 'personal' : row.scope, state: row.state, source: row.source,
    version: row.version, hash: row.contentHash, body: row.body,
    ...(row.applicability ? { applicability: row.applicability, affectedTaskIds: row.affectedTaskIds } : {}),
  }));
  const payload = { rows, omitted: result.rows.length - rows.length, projectMode: result.projectMode, accountMode: result.accountMode,
    ...(mode === 'decisions' ? { mode: 'formal_read' } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments ?? {};
  if (params.name === decisions.name && includeDecisions) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw Error('Scope is bound to caller');
    if (projectOnly) return readProjectOnly('decisions', '');
    const ctx = context([]);
    const rows = [];
    for (const c of ctx.agreements) {
      if (c.projectId !== ctx.project.id || !c.affectedTaskIds.includes(ctx.task.id) || c.status !== 'confirmed'
        || typeof c.after !== 'string' || !Number.isInteger(c.version) || !/^[0-9a-f]{64}$/i.test(c.hash)) throw Error('Invalid decision source');
      if (rows.length < 4 && Buffer.byteLength(c.after) <= 1536) rows.push({ scope: 'project', state: 'confirmed', source: c.id,
        version: c.version, hash: c.hash, body: c.after });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ mode: 'formal_read', rows, omitted: ctx.agreements.length - rows.length }) }] };
  }
  if (params.name !== tool.name || !args || Object.keys(args).length !== 1 || typeof args.query !== 'string'
    || !args.query.trim() || args.query.length > 256 || args.query.startsWith('-')) throw Error('Invalid read request');
  if (projectOnly) return readProjectOnly('search', args.query);
  const ctx = context(['--query', args.query]);
  const projectMode = ctx.retrieval.projectKnowledge.mode;
  const accountMode = ctx.retrieval.accountExperience.mode;
  const rows = [];
  if (['engine', 'canonical_lexical', 'hybrid'].includes(projectMode)) {
    for (const item of ctx.projectKnowledge) rows.push({ scope: 'project', state: item.status, source: item.id, body: item.text });
  }
  if (accountMode === 'engine') {
    for (const item of ctx.accountExperience) rows.push({ scope: 'personal', state: 'approved', source: item.id, body: item.text });
  }
  return { content: [{ type: 'text', text: JSON.stringify({ projectMode, accountMode, rows }) }] };
});
await server.connect(new StdioServerTransport());
