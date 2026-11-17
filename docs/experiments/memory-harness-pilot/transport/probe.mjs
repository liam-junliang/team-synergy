import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

// Trusted launcher bindings are synthetic in this experiment. Production derives
// them from a TSP session and an authorized workspace binding.
const root = realpathSync(process.env.TSP_PROBE_DIR);
const binding = JSON.parse(readFileSync(join(root, 'synthetic-fixture.json'), 'utf8'));
const actor = process.env.TSP_PROBE_ACTOR;
const project = process.env.TSP_PROBE_PROJECT;
if (!binding.members[project]?.includes(actor)) throw Error('Unbound fixture identity');
const session = binding.sessions.find(s => s.actor === actor && s.project === project);
const db = new DatabaseSync(join(root, 'pilot.sqlite'));
db.exec('PRAGMA busy_timeout=3000');
db.exec([
  'CREATE TABLE IF NOT EXISTS lines (stream TEXT, position INTEGER, hash TEXT, PRIMARY KEY (stream,position))',
  'CREATE TABLE IF NOT EXISTS inbox (source TEXT PRIMARY KEY, actor TEXT, project TEXT, session TEXT, role TEXT, body TEXT)',
  'CREATE TABLE IF NOT EXISTS memory (source TEXT, scope TEXT, owner TEXT, project TEXT, state TEXT, body TEXT, PRIMARY KEY(source,scope))',
].join(';'));

const hash = text => createHash('sha256').update(text).digest('hex');

// This codebook models extraction output for exactly two synthetic passages.
// Classification quality, real inference and publication policy are separate probes.
function classifyFixture(source, text) {
  const put = db.prepare('INSERT INTO memory VALUES (?, ?, ?, ?, ?, ?)');
  if (text.includes('退款超过七天也许需要人工审核')) {
    put.run(source, 'project', null, project, 'discussed', '退款超过七天是否需要人工审核，正在讨论。');
  }
  if (text.includes('我在这个项目习惯写中文提交说明')) {
    put.run(source, 'personal', actor, project, 'preference', '本项目偏好中文提交说明。');
  }
}

function capture(event) {
  if (!session || event.hook_event_name !== 'Stop' || event.session_id !== session.id ||
      realpathSync(event.cwd) !== realpathSync(join(root, session.cwd))) throw Error('Unbound host event');
  const file = realpathSync(join(root, session.transcript));
  if (realpathSync(event.transcript_path) !== file || statSync(file).size > 1024 * 1024) throw Error('Unbound or oversized fixture transcript');
  const raw = readFileSync(file, 'utf8');
  // A running host may still be writing the final JSONL record.
  const lines = raw.split('\n').slice(0, -1);
  const stream = hash(JSON.stringify([actor, project, session.id]));
  let appended = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const history = db.prepare('SELECT hash FROM lines WHERE stream=? ORDER BY position').all(stream);
    if (lines.length < history.length) throw Error('Transcript shortened; reconcile before replay');
    for (let i = 0; i < lines.length; i++) {
      const digest = hash(lines[i]);
      if (i < history.length) {
        if (history[i].hash !== digest) throw Error('Transcript diverged; rebind source before replay');
        continue;
      }
      const row = JSON.parse(lines[i]);
      db.prepare('INSERT INTO lines VALUES (?, ?, ?)').run(stream, i, digest);
      const message = row.payload;
      if (row.type !== 'response_item' || message?.type !== 'message' || !['user','assistant'].includes(message.role)) continue;
      const text = (message.content ?? []).filter(item => ['input_text','output_text'].includes(item.type)).map(item => item.text).join('\n');
      if (!text.trim()) continue;
      const source = hash(JSON.stringify([stream, i, digest]));
      db.prepare('INSERT INTO inbox VALUES (?, ?, ?, ?, ?, ?)').run(source, actor, project, session.id, message.role, text);
      if (message.role === 'user') classifyFixture(source, text);
      appended++;
    }
    db.exec('COMMIT');
    return { appended };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function search(args) {
  if (args === null || typeof args !== 'object' || Object.keys(args).length !== 1 ||
      typeof args.query !== 'string' || !args.query.trim() || args.query.length > 256) throw Error('Expected a single nonempty query');
  return db.prepare(
    'SELECT scope,state,body,source FROM memory WHERE project=? AND (scope=? OR (scope=? AND owner=?)) AND instr(body,?)>0 ORDER BY source,scope LIMIT 8'
  ).all(project, 'project', 'personal', actor, args.query.trim());
}

const tool = {
  name: 'search_memory',
  description: '按需查找当前项目的讨论与本人适用的习惯，结果保留状态和来源。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['query'], additionalProperties: false },
};

async function serve() {
  let stage = 'new';
  const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let req;
    try { req = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      send({ id: null, error: { code: -32600, message: 'Invalid request' } });
      continue;
    }
    if (req.id === undefined) {
      if (stage === 'negotiated' && req.method === 'notifications/initialized') stage = 'ready';
      continue;
    }
    const result = value => send({ id: req.id, result: value });
    const error = (code, message) => send({ id: req.id, error: { code, message } });
    if (req.method === 'initialize' && stage === 'new') {
      if (typeof req.params?.protocolVersion !== 'string' || !req.params.capabilities || !req.params.clientInfo) {
        error(-32602, 'Invalid initialization');
        continue;
      }
      stage = 'negotiated';
      result({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tsp-memory-fixture', version: '0.1' } });
    } else if (req.method === 'ping') {
      result({});
    } else if (stage !== 'ready') {
      error(-32002, 'Initialize first');
    } else if (req.method === 'tools/list') {
      result({ tools: [tool] });
    } else if (req.method === 'tools/call' && req.params?.name === tool.name) {
      try { result({ content: [{ type: 'text', text: JSON.stringify(search(req.params.arguments)) }] }); }
      catch { error(-32602, 'Invalid search arguments'); }
    } else {
      error(req.method === 'tools/call' ? -32602 : -32601, 'Unknown tool or method');
    }
  }
}

try {
  switch (process.argv[2]) {
    case 'mcp':
      await serve();
      break;
    case 'search':
      console.log(JSON.stringify(search({ query: process.argv[3] })));
      break;
    case 'hook':
      console.log(JSON.stringify(capture(JSON.parse(readFileSync(0, 'utf8')))));
      break;
    default:
      throw Error('Expected mcp, search or hook');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
