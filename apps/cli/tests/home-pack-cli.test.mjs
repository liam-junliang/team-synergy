import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderContextPackFromTask } from '../dist/pack.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const overview = { document_code: 'overview-one', title: 'Project overview', summary: 'Overview summary', content: 'Only one copy of the overview body', revision: 3, updated_at: 't3' };
const rules = { document_code: 'rules-one', title: 'Contributor rules', summary: 'Read before implementation', content: 'Pinned contributor rules body', revision: 7, updated_at: 't7' };
const apiRules = { document_code: 'rules-two', title: 'API standards', summary: 'API conventions', content: 'Pinned API standards body', revision: 4, updated_at: 't4' };
const home = { project_code: 'project-one', overview, guide: rules, standards: [rules, apiRules], standards_folder_code: 'standards-folder' };
const libraryDocument = (document) => ({ ...document, folder_code: null, kind: 'general', current_revision: document.revision, status: 'active' });
const projectDocument = { project_code: 'project-one', title: 'Obsolete project body', content: 'Do not use the unrelated document', revision: 99 };

test('project home roles reuse exact document revisions and preserve the overview path without duplicating bodies', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-home-pack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = renderContextPackFromTask({ task_code: 'task-one', title: 'Build from the required project guidance' },
    { workspaceRoot: root, runCode: 'run-one', principalCode: 'user-one' }, projectDocument, undefined,
    { home, folders: [], documents: [libraryDocument(overview), { ...libraryDocument(rules), current_revision: 8, content: 'Newer unselected rules' }] });
  assert.equal(path.basename(result.projectDocumentPath), 'project-document.md');
  assert.equal(result.handoffDocumentPaths.length, 3);
  assert.equal(result.handoffDocumentPaths[0], result.projectDocumentPath);
  const brief = readFileSync(result.briefPath, 'utf8');
  const index = readFileSync(result.handoffIndexPath, 'utf8');
  assert.match(brief, /项目说明：\[Project overview\]\(project-document.md\).*Revision 3/);
  assert.match(brief, /参与指引：\[Contributor rules\]\(handoff\/rules-one.md\).*Revision 7/);
  assert.match(brief, /项目规范：\[Contributor rules\]\(handoff\/rules-one.md\).*Revision 7/);
  assert.match(index, /项目规范：\[Contributor rules\]\(\.\.\/handoff\/rules-one.md\).*Revision 7/);
  assert.match(brief, /项目规范：\[API standards\]\(handoff\/rules-two.md\).*Revision 4/);
  assert.match(index, /项目规范：\[API standards\]\(\.\.\/handoff\/rules-two.md\).*Revision 4/);
  assert.equal(brief.match(/^- 项目规范：/gm).length, 2);
  assert.match(readFileSync(result.projectDocumentPath, 'utf8'), /Only one copy of the overview body/);
  assert.match(readFileSync(result.handoffDocumentPaths[1], 'utf8'), /Revision: 7/);
  assert.match(readFileSync(result.handoffDocumentPaths[1], 'utf8'), /Pinned contributor rules body/);
  assert.match(readFileSync(result.handoffDocumentPaths[2], 'utf8'), /Revision: 4/);
  assert.match(readFileSync(result.handoffDocumentPaths[2], 'utf8'), /Pinned API standards body/);
  assert.equal(new Set(result.handoffDocumentPaths).size, 3, 'A document shared by guide and standards must have only one body file');
  assert.doesNotMatch(brief + index, /Only one copy of the overview body|Pinned contributor rules body|Newer unselected rules|Do not use the unrelated document/);
  assert.equal(existsSync(path.join(path.dirname(result.handoffIndexPath), 'overview-one.md')), false);
});

test('home roles mark unconfigured guidance explicitly and include bound documents missing from the library list', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-home-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = renderContextPackFromTask({ task_code: 'task-one', title: 'Task' },
    { workspaceRoot: root, runCode: 'run-one', principalCode: 'user-one' }, projectDocument, undefined,
    { home: { project_code: 'project-one', overview: null, guide: null, standards: [rules], standards_folder_code: 'standards-folder' }, folders: [], documents: [] });
  const brief = readFileSync(result.briefPath, 'utf8');
  assert.match(brief, /项目说明：尚未配置/); assert.match(brief, /参与指引：尚未配置/);
  assert.match(brief, /项目规范：.*Revision 7/);
  assert.match(readFileSync(result.projectDocumentPath, 'utf8'), /项目首页尚未配置项目说明/);
  assert.equal(result.handoffDocumentPaths.length, 1);
  assert.match(readFileSync(result.handoffDocumentPaths[0], 'utf8'), /Pinned contributor rules body/);
});

test('empty standards folders are explicit, and legacy single-standard or null home responses remain readable', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-home-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, standards] of [['empty', []], ['legacy-empty', null], ['legacy-one', rules]]) {
    const result = renderContextPackFromTask({ task_code: 'task-one', title: 'Task' },
      { workspaceRoot: path.join(root, name), runCode: 'run-one', principalCode: 'user-one' }, projectDocument, undefined,
      { home: { project_code: 'project-one', overview: null, guide: null, standards }, folders: [], documents: [] });
    const brief = readFileSync(result.briefPath, 'utf8');
    const index = readFileSync(result.handoffIndexPath, 'utf8');
    if (name === 'legacy-one') {
      assert.match(brief, /项目规范：\[Contributor rules\].*Revision 7/);
      assert.match(index, /项目规范：\[Contributor rules\].*Revision 7/);
      assert.equal(result.handoffDocumentPaths.length, 1);
      assert.match(readFileSync(result.handoffDocumentPaths[0], 'utf8'), /Pinned contributor rules body/);
    } else {
      assert.match(brief, /项目规范：暂无规范文档/);
      assert.match(index, /项目规范：暂无规范文档/);
      assert.equal(result.handoffDocumentPaths.length, 0);
    }
  }
});

test('task attach fetches the bound home documents and makes all required roles available to the Agent', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-home-attach-'));
  const calls = [];
  const requirement = { document_code: 'requirements-one', title: 'Task requirements', module_key: 'AUTH', state: 'active',
    current_revision: 5, summary: 'Current task requirement summary', content: 'Original requirement body at revision five' };
  const unrelated = { ...requirement, document_code: 'requirements-other', title: 'Other requirements', content: 'Unrelated requirement body' };
  const documents = [libraryDocument(overview), { ...libraryDocument(rules), source_kind: 'project' }, libraryDocument(apiRules),
    ...[requirement, unrelated].map(document => ({ ...document, source_kind: 'requirement', folder_code: 'requirements-folder', kind: 'doc', status: 'active' })),
    { document_code: 'architecture-one', source_kind: 'architecture', folder_code: 'architecture-folder', kind: 'diagram',
      title: 'System diagram', current_revision: 2, content: 'Architecture notes without the original diagram source', status: 'active' },
    { document_code: 'testing-one', source_kind: 'testing', folder_code: 'testing-folder', kind: 'doc',
      title: 'Test scripts archive', current_revision: 1, content: 'Optional test asset payload', status: 'active' }];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ url: req.url, authorization: req.headers.authorization });
    let data;
    if (req.url === '/tasks/task-one') data = { task_code: 'task-one', project_code: 'project-one', requirement_code: 'requirement-one', title: 'Task', status: 'assigned', base_snapshot: 1 };
    else if (req.url === '/projects/project-one/home') data = home;
    else if (req.url === '/projects/project-one/requirement-documents') data = [requirement, unrelated].map(({ content, ...summary }) => summary);
    else if (req.url === '/requirements/requirement-one') data = { document_code: requirement.document_code };
    else if (req.url === `/requirement-documents/${requirement.document_code}`) data = requirement;
    else if (req.url === '/projects/project-one/handoff') data = { folders: [], documents };
    else if (req.url.startsWith('/handoff-documents/')) data = documents.find((document) => req.url.endsWith(document.document_code));
    else if (req.url === '/tasks/task-one/claim') data = { ...JSON.parse(raw), status: 'running' };
    else if (/^\/runs\/[0-9A-HJKMNP-TV-Z]{20}\/skills$/.test(req.url)) data = { project_code: '11111111111111111111', generation: 0, skills: [] };
    else { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: req.url } })); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  for (const args of [['init'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(path.join(root, 'README.md'), 'Repository\n');
  for (const args of [['add', 'README.md'], ['commit', '-m', 'Fixture']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  const child = spawn(process.execPath, [cli, 'task', 'attach', 'task-one', '--profile', 'builder', '--workspace', root], {
    cwd: root, env: { ...process.env, AGENTCTL_HOME: path.join(root, 'auth'), ACP_API_URL: `http://127.0.0.1:${server.address().port}`, ACP_TOKEN: 'home-test-token', ACP_DEVICE_TOKEN: '', ACP_PRINCIPAL_CODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(status, 0, output + errors);
  const result = JSON.parse(output); assert.equal(result.ok, true, output);
  assert.match(readFileSync(result.data.skills_index, 'utf8'), /该 Run 未启用技能/);
  assert.ok(calls.some((call) => call.url === '/projects/project-one/home'));
  assert.ok(!calls.some((call) => call.url.endsWith('/document')));
  assert.ok(calls.every((call) => call.authorization === 'Bearer home-test-token'));
  assert.match(readFileSync(result.data.project_document, 'utf8'), /Only one copy of the overview body/);
  assert.match(readFileSync(result.data.pack, 'utf8'), /项目规范：.*Revision 7/);
  assert.match(readFileSync(result.data.pack, 'utf8'), /项目规范：\[API standards\].*Revision 4/);
  assert.equal(result.data.handoff_documents.length, 3);
  assert.equal(result.data.handoff_documents[0], result.data.project_document);
  assert.ok(calls.some(call => call.url === '/requirement-documents/requirements-one'));
  assert.ok(!calls.some(call => call.url === '/requirement-documents/requirements-other'));
  assert.ok(!calls.some(call => call.url.startsWith('/handoff-documents/requirements-')), 'Requirement library projections must not be fetched as extra handoff bodies');
  assert.ok(!calls.some(call => call.url === '/handoff-documents/architecture-one'), 'Architecture must remain available on demand with its source, rather than a notes-only Markdown copy');
  assert.ok(!calls.some(call => call.url === '/handoff-documents/testing-one'), 'Testing assets must remain opt-in rather than copying file payloads into every task');
  assert.equal(path.basename(result.data.requirement_document), 'requirements-one.md');
  assert.match(readFileSync(result.data.requirement_document, 'utf8'), /Original requirement body at revision five/);
  assert.match(readFileSync(result.data.requirement_document, 'utf8'), /Revision: 5/);
  assert.match(readFileSync(result.data.requirements_index, 'utf8'), /requirements-one/);
  assert.match(readFileSync(result.data.requirements_index, 'utf8'), /requirements-other/);
  assert.doesNotMatch(readFileSync(result.data.handoff_index, 'utf8'), /Task requirements|Other requirements/);
  assert.doesNotMatch(readFileSync(result.data.handoff_index, 'utf8'), /System diagram|Architecture notes/);
  assert.match(readFileSync(result.data.handoff_index, 'utf8'), /tsp architecture show/);
  assert.match(readFileSync(result.data.handoff_index, 'utf8'), /tsp docs search/);
  assert.match(readFileSync(result.data.pack, 'utf8'), /tsp architecture list/);
  assert.equal(existsSync(path.join(path.dirname(result.data.handoff_index), 'requirements-one.md')), false);
  assert.equal(existsSync(path.join(path.dirname(result.data.handoff_index), 'architecture-one.md')), false);
  assert.equal(existsSync(path.join(path.dirname(result.data.requirement_document), 'requirements-other.md')), false);
});

test('docs and legacy handoff list, search and show share original library routes and revisions', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-requirement-library-cli-'));
  const calls = [];
  const document = { document_code: 'requirements-one', source_kind: 'requirement', folder_code: 'requirements-folder',
    title: 'Requirement document', kind: 'doc', status: 'active', can_edit: false, source_can_edit: true,
    current_revision: 2, content: '# Original requirement body',
    revisions: [{ revision_code: 'original-revision-two', revision: 2, content: '# Original requirement body' },
      { revision_code: 'original-revision-one', revision: 1, content: '# Earlier requirement body' }] };
  const folders = [{ folder_code: 'requirements-folder', name: '需求文档', parent_folder_code: null, status: 'active', system_role: 'requirements', can_edit: false }];
  const server = createServer((req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization });
    const data = req.url.startsWith('/projects/project-one/handoff') ? { folders, documents: [document] }
      : req.url === '/handoff-documents/requirements-one' ? document : null;
    res.statusCode = data ? 200 : 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(data ? { ok: true, data } : { ok: false, error: { code: 'not_found', message: req.url } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const outputPath = path.join(root, 'requirement.md');
  const results = [];
  for (const group of ['docs', 'handoff']) {
    results.push(await runLibraryCli(root, server, ['list', '--project', 'project-one'], group));
    results.push(await runLibraryCli(root, server, ['search', '登录', '--project', 'project-one'], group));
    results.push(await runLibraryCli(root, server, ['show', 'requirements-one', '--output', outputPath], group));
  }
  assert.deepEqual(results[0].folders, folders);
  assert.deepEqual(results[0].documents, [document]);
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], { ...document, exported_path: outputPath });
  assert.deepEqual(results.slice(3), results.slice(0, 3));
  assert.equal(readFileSync(outputPath, 'utf8'), document.content);
  assert.ok(calls.every(call => call.authorization === 'Bearer library-test-token'));
  assert.deepEqual(calls.slice(3), calls.slice(0, 3));
  assert.equal(new URL(calls[1].url, 'http://localhost').searchParams.get('q'), '登录');
});

async function runLibraryCli(root, server, args, group = 'docs') {
  const child = spawn(process.execPath, [cli, group, ...args], { cwd: root, env: { ...process.env,
    AGENTCTL_HOME: path.join(root, 'auth'), ACP_API_URL: `http://127.0.0.1:${server.address().port}`,
    ACP_TOKEN: 'library-test-token', ACP_DEVICE_TOKEN: '', ACP_PRINCIPAL_CODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(status, 0, output + errors);
  const result = JSON.parse(output); assert.equal(result.ok, true, output);
  return result.data;
}

test('docs architecture projection retains source, preview and original revisions without a second document', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-architecture-library-cli-'));
  const current = { revision_code: 'architecture-revision-two', revision: 2, content_kind: 'drawio',
    source_content: '<mxfile><diagram id="system">original XML</diagram></mxfile>', preview_svg: '<svg/>', notes_markdown: '# Current notes' };
  const earlier = { revision_code: 'architecture-revision-one', revision: 1, content_kind: 'mermaid',
    source_content: 'flowchart LR\nWeb --> API', preview_svg: null, notes_markdown: '# Earlier notes' };
  const architecture = { document_code: 'architecture-one', current_revision: 2, ...current, revisions: [current, earlier] };
  const document = { document_code: architecture.document_code, source_kind: 'architecture', folder_code: 'architecture-folder',
    kind: 'diagram', title: 'System architecture', current_revision: 2, content: current.notes_markdown,
    can_edit: false, source_can_edit: true, architecture_document: architecture,
    revisions: [current, earlier].map(version => ({ ...version, content: version.notes_markdown })) };
  const folders = [{ folder_code: 'architecture-folder', name: '架构设计', parent_folder_code: null, system_role: 'architecture', can_edit: false }];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer library-test-token');
    const data = req.url === '/projects/project-one/handoff' ? { folders, documents: [document] }
      : req.url === '/handoff-documents/architecture-one' ? document : null;
    res.statusCode = data ? 200 : 404; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(data ? { ok: true, data } : { ok: false, error: { code: 'not_found', message: req.url } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(await runLibraryCli(root, server, ['list', '--project', 'project-one']), { folders, documents: [document] });
  const output = path.join(root, 'architecture-notes.md');
  const shown = await runLibraryCli(root, server, ['show', document.document_code, '--output', output]);
  assert.deepEqual(shown, { ...document, exported_path: output });
  assert.deepEqual(shown.architecture_document.revisions, [current, earlier]);
  assert.equal(readFileSync(output, 'utf8'), current.notes_markdown);
});

test('docs accepts DOC/API/DIAGRAM values and legacy kinds, preserving legacy classification on content-only revisions', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-library-kinds-cli-'));
  const file = path.join(root, 'document.md'); writeFileSync(file, '# Source\n\nOriginal Markdown', 'utf8');
  const writes = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let data;
    if (req.method === 'GET' && req.url === '/handoff-documents/existing') {
      data = { document_code: 'existing', kind: 'doc', legacy_kind: 'deployment', title: 'Deployment guide', summary: '', current_revision: 4 };
    } else if (['POST', 'PATCH'].includes(req.method)) {
      data = { document_code: 'existing', ...JSON.parse(raw) }; writes.push(data);
    }
    res.statusCode = data ? 200 : 404; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(data ? { ok: true, data } : { ok: false, error: { code: 'not_found', message: req.url } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const createArgs = ['create', '--project', 'project-one', '--title', 'Document', '--file', file];
  await runLibraryCli(root, server, createArgs);
  assert.equal(writes.at(-1).kind, 'doc');
  for (const kind of ['doc', 'api', 'diagram', 'general', 'integration', 'deployment', 'data', 'operations', 'release']) {
    await runLibraryCli(root, server, [...createArgs, '--kind', kind]);
    assert.equal(writes.at(-1).kind, kind);
    assert.equal(writes.at(-1).content, '# Source\n\nOriginal Markdown');
  }
  await runLibraryCli(root, server, ['revise', 'existing', '--file', file, '--change', 'Body update']);
  assert.equal(writes.at(-1).kind, 'deployment');
  await runLibraryCli(root, server, ['revise', 'existing', '--file', file, '--change', 'Type update', '--kind', 'diagram']);
  assert.equal(writes.at(-1).kind, 'diagram');
  await runLibraryCli(root, server, [...createArgs, '--kind', 'api'], 'handoff');
  assert.equal(writes.at(-1).kind, 'api');
  assert.equal(writes.at(-1).content, '# Source\n\nOriginal Markdown');
});
