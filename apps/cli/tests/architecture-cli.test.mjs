import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
async function run(root, url, args) {
  const child = spawn(process.execPath, [cli, 'architecture', ...args], {
    cwd: root, env: { ...process.env, AGENTCTL_HOME: path.join(root, 'auth'), ACP_API_URL: url,
      ACP_TOKEN: 'architecture-test-token', ACP_DEVICE_TOKEN: '', ACP_PRINCIPAL_CODE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { status, ...JSON.parse(output || assert.fail(errors)) };
}

test('architecture CLI preserves source, revisions and optimistic writes, with authenticated exports of original files', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-architecture-cli-'));
  const calls = [];
  let current;
  const revisions = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ url: req.url, method: req.method, body, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'PATCH' && body.base_revision !== current.current_revision) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: { code: 'architecture_document_revision_conflict', message: 'Refresh first' } })); return;
    }
    if (req.method === 'POST' || req.method === 'PATCH') {
      const { base_revision, ...input } = body;
      current = { document_code: 'architecture-one', project_code: 'project-one', preview_svg: null, notes_markdown: '',
        ...current, ...input, current_revision: (current?.current_revision ?? 0) + 1 };
      revisions.unshift({ ...current, revision: current.current_revision, revision_code: `revision-${current.current_revision}` });
    }
    const data = req.url.startsWith('/projects/') && req.method === 'GET' ? [current] : { ...current, revisions };
    res.end(JSON.stringify({ ok: true, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const source = 'flowchart LR\n  Web[网页] --> API[服务]\n';
  const xml = '<mxfile><diagram name="架构"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
  const mmdFile = path.join(root, 'system.mmd'); writeFileSync(mmdFile, source);
  const xmlFile = path.join(root, 'system.drawio'); writeFileSync(xmlFile, xml);
  const notes = path.join(root, 'notes.md'); writeFileSync(notes, '# 架构说明\n\n原始文字。');
  const created = await run(root, url, ['create', '--project', 'project-one', '--title', '系统架构', '--file', mmdFile, '--notes-file', notes]);
  assert.equal(created.status, 0); assert.equal(created.data.source_content, source);
  assert.equal(calls[0].url, '/projects/project-one/architecture-documents');
  assert.equal(calls[0].body.content_kind, 'mermaid');
  assert.equal(calls[0].body.notes_markdown, '# 架构说明\n\n原始文字。');
  const revised = await run(root, url, ['revise', 'architecture-one', '--base-revision', '1', '--change', '改用可编辑画布', '--file', xmlFile]);
  assert.equal(revised.status, 0); assert.equal(revised.data.current_revision, 2);
  assert.equal(revised.data.source_content, xml); assert.equal(revised.data.content_kind, 'drawio');
  assert.equal(calls.at(-1).body.base_revision, 1);
  assert.equal('preview_svg' in calls.at(-1).body, false, 'The server clears stale previews when the source changes');
  const metadata = await run(root, url, ['revise', 'architecture-one', '--base-revision', '2', '--change', '补充标题', '--title', '总体架构']);
  assert.equal(metadata.status, 0); assert.equal(metadata.data.source_content, xml);
  assert.deepEqual(calls.at(-1).body, { title: '总体架构', base_revision: 2, change_summary: '补充标题' });
  const conflict = await run(root, url, ['revise', 'architecture-one', '--base-revision', '2', '--change', '过期编辑', '--file', mmdFile]);
  assert.equal(conflict.status, 1); assert.equal(conflict.error.code, 'architecture_document_revision_conflict');
  assert.equal(current.current_revision, 3); assert.equal(current.source_content, xml);
  const listed = await run(root, url, ['list', '--project', 'project-one', '--query', '总体 架构']);
  assert.equal(listed.status, 0); assert.equal(listed.data[0].document_code, 'architecture-one');
  assert.equal(calls.at(-1).url, '/projects/project-one/architecture-documents?q=%E6%80%BB%E4%BD%93%20%E6%9E%B6%E6%9E%84');
  const exported = path.join(root, 'revision-one.mmd');
  const historical = await run(root, url, ['show', 'architecture-one', '--revision', '1', '--output', exported]);
  assert.equal(historical.status, 0); assert.equal(historical.data.selected_revision, 1);
  assert.equal(historical.data.title, '系统架构'); assert.equal(readFileSync(exported, 'utf8'), source);
  const requests = calls.length;
  assert.equal((await run(root, url, ['show', 'architecture-one', '--output', exported])).error.code, 'output_exists');
  assert.equal(calls.length, requests); assert.equal(readFileSync(exported, 'utf8'), source);
  assert.equal((await run(root, url, ['show', 'architecture-one', '--output', exported, '--force'])).status, 0);
  assert.equal(readFileSync(exported, 'utf8'), xml);
  const missing = path.join(root, 'missing.mmd');
  assert.equal((await run(root, url, ['show', 'architecture-one', '--revision', '99', '--output', missing])).error.code, 'architecture_revision_not_found');
  assert.equal(existsSync(missing), false);
  const invalidRequests = calls.length;
  for (const args of [
    ['revise', 'architecture-one', '--base-revision', '1.2', '--change', 'invalid'],
    ['revise', 'architecture-one', '--base-revision', '3', '--change', 'invalid', '--kind', 'drawio'],
    ['create', '--project', 'project-one', '--title', 'invalid', '--file', mmdFile, '--kind', 'html'],
    ['show', 'architecture-one', '--revision', '0'],
  ]) assert.equal((await run(root, url, args)).status, 1);
  assert.equal(calls.length, invalidRequests, 'Invalid options must fail before HTTP writes');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8x8AAAAASUVORK5CYII=', 'base64');
  const imageFile = path.join(root, 'diagram.png'); writeFileSync(imageFile, png);
  assert.equal((await run(root, url, ['revise', 'architecture-one', '--base-revision', '3', '--change', '图片版', '--file', imageFile])).status, 0);
  const pngOut = path.join(root, 'export.png');
  assert.equal((await run(root, url, ['show', 'architecture-one', '--output', pngOut])).status, 0);
  assert.deepEqual(readFileSync(pngOut), png);
  assert.ok(calls.every(call => call.auth === 'Bearer architecture-test-token'));
});
