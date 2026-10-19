import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { renderContextPackFromTask } from '../dist/pack.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
async function run(root, url, args) {
  const child = spawn(process.execPath, [cli, 'design', ...args], {
    cwd: root, env: { ...process.env, AGENTCTL_HOME: path.join(root, 'auth'), ACP_API_URL: url, ACP_TOKEN: 'design-test-token', ACP_DEVICE_TOKEN: '', ACP_PRINCIPAL_CODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { status, ...JSON.parse(output || assert.fail(errors)) };
}

test('design CLI validates one source, preserves metadata-only revisions and downloads original bytes with authentication', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-design-cli-'));
  const calls = [];
  const bytes = Buffer.from([0, 255, 12, 90, 1]);
  const history = new Map();
  let current = { prototype_code: 'design-one', current_revision: 0, linked_requirements: [] };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ url: req.url, method: req.method, body, authorization: req.headers.authorization });
    if (req.url.startsWith('/design-prototypes/design-one/file?')) {
      const revision = Number(new URL(req.url, 'http://local').searchParams.get('revision'));
      const file = history.get(revision)?.file_content_base64;
      if (file) { res.setHeader('content-type', 'application/octet-stream'); res.end(Buffer.from(file, 'base64')); return; }
      res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: { code: 'file_not_found', message: 'No attachment' } })); return;
    }
    if (req.method === 'POST' || req.method === 'PATCH') {
      current = { ...current, ...body, current_revision: current.current_revision + 1 };
      history.set(current.current_revision, current);
    }
    const { file_content_base64: _upload, ...data } = current;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const base = ['create', '--project', 'project-one', '--title', 'Material'];
  for (const args of [base, [...base, '--url', 'https://example.com', '--file', 'missing.html'], [...base, '--url', 'javascript:alert(1)'], [...base, '--url', 'https://user:secret@example.com']]) {
    assert.equal((await run(root, url, args)).ok, false);
  }
  assert.equal(calls.length, 0, 'Invalid sources must fail before requesting the server');
  const created = await run(root, url, [...base, '--url', 'https://example.com/prototype?frame=one']);
  assert.equal(created.ok, true); assert.equal(created.data.content_kind, 'url');
  assert.equal(created.data.external_url, 'https://example.com/prototype?frame=one');
  const revised = await run(root, url, ['revise', 'design-one', '--change', 'Clarify title', '--title', 'Renamed']);
  assert.equal(revised.ok, true); assert.equal(revised.data.external_url, created.data.external_url);
  const metadataBody = calls.find((call) => call.method === 'PATCH').body;
  assert.equal('content_kind' in metadataBody, false); assert.equal('html_content' in metadataBody, false);
  const htmlOut = path.join(root, 'misleading.html');
  const invalidExport = await run(root, url, ['show', 'design-one', '--output', htmlOut]);
  assert.equal(invalidExport.error.code, 'design_export_unsupported'); assert.equal(existsSync(htmlOut), false);
  const attachment = path.join(root, 'source.fig'); writeFileSync(attachment, bytes);
  const attached = await run(root, url, ['revise', 'design-one', '--change', 'Original source file', '--attachment', attachment]);
  assert.equal(attached.ok, true); assert.equal(attached.data.content_kind, 'file'); assert.equal(attached.data.file_name, 'source.fig');
  assert.deepEqual(Buffer.from(calls.at(-1).body.file_content_base64, 'base64'), bytes);
  await run(root, url, ['revise', 'design-one', '--change', 'Back to external link', '--url', 'https://example.com/new']);
  const output = path.join(root, 'restored.fig');
  const downloaded = await run(root, url, ['download', 'design-one', '--revision', '3', '--out', output]);
  assert.equal(downloaded.ok, true); assert.deepEqual(readFileSync(output), bytes);
  assert.equal(calls.at(-1).url, '/design-prototypes/design-one/file?revision=3');
  assert.ok(calls.every((call) => call.authorization === 'Bearer design-test-token'));
  const count = calls.length;
  assert.equal((await run(root, url, ['download', 'design-one', '--revision', '3', '--out', output])).error.code, 'output_exists');
  assert.equal(calls.length, count); assert.deepEqual(readFileSync(output), bytes);
  assert.equal((await run(root, url, ['download', 'design-one', '--revision', '3', '--out', output, '--force'])).ok, true);
  const missing = path.join(root, 'missing.fig');
  assert.equal((await run(root, url, ['download', 'design-one', '--revision', '1', '--out', missing])).error.code, 'file_not_found');
  assert.equal(existsSync(missing), false);
  assert.equal((await run(root, url, ['download', 'design-one', '--revision', '1.5', '--out', missing])).error.code, 'design_revision_invalid');
  const image = path.join(root, 'image.png'); writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'));
  const imageResult = await run(root, url, [...base, '--image', image]);
  assert.equal(imageResult.ok, true); assert.equal(imageResult.data.content_kind, 'image'); assert.match(imageResult.data.html_content, /data:image\/png;base64,/);
});

test('Context Pack keeps HTML paths and records external sources and exact attachment revisions without downloading', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-design-pack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = { title: 'Design', summary: '', status: 'ready', current_revision: 7, html_content: '', notes_markdown: 'Read these notes' };
  const attachment = { ...base, prototype_code: 'file-one', content_kind: 'file', file_name: 'source.fig', file_mime_type: 'application/octet-stream', file_size: 4, file_sha256: createHash('sha256').update('data').digest('hex'), download_path: '/design-prototypes/file-one/file?revision=7' };
  const rendered = renderContextPackFromTask({ task_code: 'task-one', title: 'Task', design_prototypes: [
    { ...base, prototype_code: 'html-one', html_content: '<h1>HTML</h1>' },
    { ...base, prototype_code: 'image-one', content_kind: 'image', html_content: '<img src="data:image/png;base64,eA==">' },
    { ...base, prototype_code: 'url-one', content_kind: 'url', external_url: 'https://example.com/design#one' }, attachment,
  ] }, { workspaceRoot: root, runCode: 'run-one', principalCode: 'user-one' }, { project_code: 'project-one', title: 'Project', content: '', revision: 1 });
  assert.deepEqual(rendered.designPrototypePaths.map((file) => path.basename(file)), ['html-one.html', 'image-one.html', 'url-one.source.md', 'file-one.source.md']);
  assert.equal(readFileSync(rendered.designPrototypePaths[0], 'utf8'), '<h1>HTML</h1>');
  assert.match(readFileSync(rendered.designPrototypePaths[2], 'utf8'), /https:\/\/example.com\/design#one/);
  const source = readFileSync(rendered.designPrototypePaths[3], 'utf8');
  assert.match(source, /tsp design download file-one --revision 7 --out <local-path>/);
  assert.match(source, new RegExp(attachment.file_sha256)); assert.match(source, /application\/octet-stream/);
  assert.equal(existsSync(path.join(path.dirname(rendered.designIndexPath), 'file-one.html')), false);
  assert.equal(existsSync(path.join(path.dirname(rendered.designIndexPath), 'source.fig')), false);
  assert.match(readFileSync(rendered.briefPath, 'utf8'), /file-one.source.md/);
});
