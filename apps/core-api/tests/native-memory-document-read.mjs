// Authenticated native document API + shipped CLI/MCP, in an isolated database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { invoke, withNativeMemoryProject } from './native-memory-live.mjs';

process.env.ACP_ALLOW_LEGACY_IDENTITY = '0';
process.env.TSP_MEMORY_ENABLED = '1';
const cli = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
const output = new URL('../../../docs/experiments/memory-project-documents/native-read.json', import.meta.url);
const report = { startedAt: new Date().toISOString(), realGitActions: 0 };
await withNativeMemoryProject({}, async f => {
  const created = await f.ok('POST', f.root + '/handoff/documents', f.alice, {
    kind: 'doc', title: '工作区缓存隔离', content: '# 当前项目背景\n\n' + '缓存隔离条件😀，需要核对项目与账号。\n'.repeat(260) + '\n文末验收：验证标记为青松。',
  });
  const current = await f.ok('GET', '/handoff-documents/' + created.document_code, f.alice);
  const source = current.revisions[0].revision_code;
  const rows = await f.ok('POST', f.root + '/memory/search', f.bob, { query: '验证标记', scope: 'project' });
  assert.equal(rows[0].source, source);
  assert.equal(rows[0].state, 'documented');
  assert.ok(rows[0].text.length <= 1600 && rows[0].excerpt.nextOffset !== null);
  const request = { source, query: '验证标记', limit: 400 };
  assert.equal((await f.http('POST', f.root + '/memory/documents/read', null, request)).status, 401);
  assert.equal((await f.http('POST', f.root + '/memory/documents/read', null, request, { 'x-principal-id': f.alice.code })).status, 401);
  assert.equal((await f.http('POST', '/projects/' + f.foreign.code + '/memory/documents/read', f.bob, request)).status, 403);
  assert.equal((await f.http('POST', f.root + '/memory/documents/read', f.bob, { ...request, principalCode: f.alice.code })).ok, false);
  const page = await f.ok('POST', f.root + '/memory/documents/read', f.bob, request);
  assert.match(page.text, /验证标记为青松/u);
  const cliPage = await invoke(f.bob, ['memory', 'document', source, '--query', '验证标记', '--limit', '400']);
  assert.match(cliPage.data.text, /验证标记为青松/u);
  const child = spawn(process.execPath, [cli, 'memory', 'mcp'], {
    cwd: f.bob.cwd, env: { ...process.env, AGENTCTL_HOME: f.bob.home }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const done = once(child, 'close'); let raw = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { raw += chunk; });
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_memory_document', arguments: request } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const timeout = setTimeout(() => child.kill(), 20000);
  try { assert.equal((await done)[0], 0); } finally { clearTimeout(timeout); }
  const reply = raw.trim().split('\n').map(row => JSON.parse(row)).find(row => row.id === 2);
  assert.match(JSON.parse(reply.result.content[0].text)[0].text, /验证标记为青松/u);
  await f.ok('PATCH', '/handoff-documents/' + created.document_code, f.alice, {
    title: '工作区缓存隔离', content: '当前修订文末验收：验证标记为白桦。', change_summary: '更正当前规则', base_revision: 1,
  });
  const old = await f.http('POST', f.root + '/memory/documents/read', f.bob, { source });
  assert.equal(old.ok, false); assert.equal(old.error.code, 'memory_source_unavailable');
  assert.deepEqual(await f.ok('POST', f.root + '/memory/sources', f.bob, { sources: [source] }), []);
  const fresh = await f.ok('POST', f.root + '/memory/search', f.bob, { query: '白桦', scope: 'project' });
  assert.equal(fresh[0].sourceRevision, 2);
  await f.db.$client.query("update users set status='disabled' where code=$1", [f.alice.code]);
  assert.equal((await f.ok('POST', f.root + '/memory/search', f.bob, { query: '白桦', scope: 'project' }))[0].source, fresh[0].source);
  report.source = source; report.currentSource = fresh[0].source;
  report.checks = { nativeWriteQueued: true, immediateProjectRead: true, boundedPreview: true,
    deviceHttpPage: true, cliPage: true, shippedMcpPage: true, unauthenticatedDenied: true,
    forgedPrincipalDenied: true, foreignProjectDenied: true, actorBodyDenied: true,
    oldSourceUnavailable: true, currentRevisionVisible: true, publicDocumentSurvivesAuthorDisable: true };
});
report.isolatedDatabaseRemoved = true; report.endedAt = new Date().toISOString();
await mkdir(new URL('./', output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ checks: report.checks, isolatedDatabaseRemoved: true }));
