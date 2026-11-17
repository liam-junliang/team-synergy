// Opt-in real integration: dedicated engines, a central leased database and two blank member clients.
// --check is offline. No business database/engine profile, replayed Agent or model fallback is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const self = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
const resultsRoot = fileURLToPath(new URL('../../../docs/experiments/project-material-index/', import.meta.url));
const enginesFile = 'F:/workspace/team-synergy-runtime/test-memory-engines/engines.private.json';
const expectedModel = 'workbuddy/deepseek-v4.1-flash';
const servedModels = new Set([expectedModel, 'deepseek-v4.1-flash']);
const kinds = ['project', 'requirement', 'architecture', 'testing'];
const hash = value => createHash('sha256').update(value).digest('hex');
const codePattern = /^[0-9A-HJKMNP-TV-Z]{20}$/u;
const check = (condition, code) => { if (!condition) { const error = new Error(code); error.code = code; throw error; } };
const safeFailure = (error, phase) => ({ phase, name: /^[A-Za-z0-9_.]{1,80}$/u.test(error?.name ?? '') ? error.name : 'Error',
  code: /^[A-Za-z0-9_:-]{1,100}$/u.test(error?.code ?? '') ? error.code : 'integration_failed' });
const cleanEnv = () => Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
const parseAnswer = text => { try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')); } catch { return null; } };

/** Score evidence facts separately from harmless quoting/formatting differences. Never relax revision identity. */
export function materialAnswerFacts(parsed, corpus) {
  if (!parsed || typeof parsed.documentStatus !== 'string' || parsed.decisionEvidence !== 'absent' || parsed.implementationEvidence !== 'absent') return false;
  if (!/(?:^|[^a-z])documented(?:$|[^a-z])/iu.test(parsed.documentStatus) ||
      /confirmed|implemented|\bnot\s+documented|不是\s*documented/iu.test(parsed.documentStatus)) return false;
  return corpus.every(item => parsed.materials?.some(row => row.kind === item.kind && row.source === item.sourceCitation &&
    (row.marker === item.marker || row.marker === '文末验收标记：' + item.marker)));
}

function localEndpoint(value, port) {
  const url = new URL(value);
  check(url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === port && !url.username && !url.password && !url.search && !url.hash, 'dedicated_loopback_endpoint_required');
  return url;
}
function validateConfig(config) {
  localEndpoint(config.tencent.coreBaseUrl, 18520); localEndpoint(config.tencent.baseUrl, 18524); localEndpoint(config.openviking.baseUrl, 21933);
  check(Object.keys(config.projects).length === 0 && Object.keys(config.accounts).length === 0 &&
    Boolean(config.projectProvisioning?.semanticAgentId), 'fresh_dynamic_project_mapping_required');
}
function corpusFor(runId) {
  return kinds.map((kind, index) => {
    const marker = '验收-' + kind + '-' + randomBytes(6).toString('hex');
    const title = '资料摘要试点 ' + kind;
    const summary = '资料摘要试点的' + ['项目说明', '需求草稿', '架构笔记', '测试计划'][index] + '，正文另有文末验收标记；这是资料，不是确认或实施证据。';
    const body = '# ' + title + '\n\n这是隔离实验中的文档陈述，负责人尚未确认，也没有实际实现或运行测试的证据。\n\n' +
      '背景材料：读取资料需要核对当前项目、不可变修订及适用范围，摘要不包含完整验收细节。\n'.repeat(45) + '\n文末验收标记：' + marker + '\n';
    return { kind, title, summary, body, marker, runId };
  });
}

/** Observation-only relay. Forward original MCP frames, retaining only synthetic evidence metadata. */
async function relay(auditFile) {
  check(path.isAbsolute(auditFile), 'absolute_audit_path_required');
  const child = spawn(process.execPath, [cli, 'mcp'], { env: { ...cleanEnv(), AGENTCTL_HOME: process.env.AGENTCTL_HOME },
    cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const done = once(child, 'close'), pending = new Map(), input = createInterface({ input: process.stdin });
  input.on('line', line => { const request = JSON.parse(line); if (request.id !== undefined) pending.set(request.id, request); child.stdin.write(line + '\n'); });
  input.on('close', () => child.stdin.end());
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const response = JSON.parse(line), request = pending.get(response.id); pending.delete(response.id);
      if (request?.method === 'tools/call') {
        const values = (response.result?.content ?? []).map(block => { try { return JSON.parse(block.text); } catch { return null; } });
        const rows = values.flatMap(value => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : value?.sourceCitation ? [value] : []);
        await appendFile(auditFile, JSON.stringify({ at: new Date().toISOString(), tool: request.params.name, args: request.params.arguments ?? {},
          error: Boolean(response.error || response.result?.isError), outputBytes: Buffer.byteLength(JSON.stringify(response.result ?? {})),
          rows: rows.map(row => ({ source: row.source ?? row.sourceCitation, state: row.state, kind: row.materialSourceKind ?? row.sourceKind,
            textChars: row.text?.length, bodyChars: row.body?.length, bodyHash: typeof row.body === 'string' ? hash(row.body) : null,
            locator: row.locator, current: row.current })) }) + '\n', { mode: 0o600 });
      }
      process.stdout.write(line + '\n');
    }
    check((await done)[0] === 0, 'mcp_relay_failed');
  } finally { input.close(); if (child.exitCode === null && child.signalCode === null) child.kill(); }
}

async function withMagpie(report, save, work) {
  const upstream = localEndpoint('http://127.0.0.1:3425', 3425), token = randomBytes(32).toString('hex');
  let upstreamKey;
  if (process.env.TSP_MAGPIE_API_KEY_FILE) {
    check(path.isAbsolute(process.env.TSP_MAGPIE_API_KEY_FILE), 'absolute_magpie_key_path_required');
    upstreamKey = (await readFile(process.env.TSP_MAGPIE_API_KEY_FILE, 'utf8')).trim();
    check(upstreamKey && !/[\r\n]/u.test(upstreamKey), 'magpie_key_file_invalid');
  }
  const gateway = createServer(async (request, response) => {
    const entry = { at: new Date().toISOString(), endpoint: request.url, phase: report.phase, models: [] };
    report.modelAudit.requests.push(entry);
    try {
      check(request.method === 'POST' && ['/v1/messages', '/v1/chat/completions', '/v1/responses'].includes(request.url), 'unsupported_model_endpoint');
      check(request.headers.authorization === 'Bearer ' + token || request.headers['x-api-key'] === token, 'unrecognized_model_client');
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; check(bytes <= 4 * 1024 * 1024, 'model_request_too_large'); chunks.push(chunk); }
      const body = Buffer.concat(chunks), payload = JSON.parse(body.toString('utf8'));
      check(payload.model === expectedModel, 'unexpected_requested_model'); entry.requestedModel = payload.model;
      const headers = { 'content-type': 'application/json', ...(upstreamKey ? { authorization: 'Bearer ' + upstreamKey, 'x-api-key': upstreamKey } : {}) };
      for (const key of ['anthropic-version', 'anthropic-beta']) if (request.headers[key]) headers[key] = request.headers[key];
      const result = await fetch(new URL(request.url, upstream), { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(120000) });
      entry.status = result.status;
      const type = result.headers.get('content-type') ?? 'application/json', decoder = new TextDecoder(); let pending = '';
      const observe = text => { try { const value = JSON.parse(text); for (const row of [value, value?.response, value?.message])
        if (typeof row?.model === 'string' && !entry.models.includes(row.model)) entry.models.push(row.model); } catch { /* Non-JSON SSE control data. */ } };
      response.writeHead(result.status, { 'content-type': type, 'cache-control': 'no-store' });
      for await (const chunk of result.body ?? []) {
        response.write(chunk); pending += decoder.decode(chunk, { stream: true });
        if (type.includes('event-stream')) { const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) if (line.startsWith('data:')) observe(line.slice(5).trim()); }
      }
      pending += decoder.decode(); if (pending.startsWith('data:')) observe(pending.slice(5).trim()); else if (pending) observe(pending);
      response.end();
    } catch (error) {
      entry.failure = safeFailure(error, report.phase);
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"Isolated model gateway failed"}}');
    } finally { await save(); }
  });
  const previous = Object.fromEntries(['TSP_EVAL_GATEWAY_URL', 'TSP_EVAL_GATEWAY_TOKEN', 'TSP_EVAL_MODEL', 'TSP_EVAL_FAMILY'].map(key => [key, process.env[key]]));
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { TSP_EVAL_GATEWAY_URL: 'http://127.0.0.1:' + gateway.address().port + '/v1', TSP_EVAL_GATEWAY_TOKEN: token,
    TSP_EVAL_MODEL: expectedModel, TSP_EVAL_FAMILY: 'deepseek-v4.1-flash' });
  try { return await work(); }
  finally {
    gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    const successful = report.modelAudit.requests.filter(row => row.status === 200);
    report.modelAudit.successfulResponses = successful.length;
    report.modelAudit.attestedResponses = successful.filter(row => row.models.length && row.models.every(model => servedModels.has(model))).length;
    report.modelAudit.accepted = successful.length > 0 && successful.length === report.modelAudit.attestedResponses &&
      report.modelAudit.requests.every(row => row.status === 200 && !row.failure);
    await save();
  }
}

async function memberFor(f, api, dir, invoke) {
  const home = path.join(dir, randomBytes(12).toString('hex')); await mkdir(home, { mode: 0o700 });
  const member = { code: f.bob.code, home: path.join(home, 'device'), cwd: path.join(home, 'work'), codexHome: path.join(home, 'session') };
  for (const folder of [member.home, member.cwd, member.codexHome]) await mkdir(folder, { mode: 0o700 });
  const auth = JSON.parse(await readFile(path.join(f.bob.home, 'auth.json'), 'utf8'));
  check(auth.device_token === f.bob.token, 'fixture_device_changed');
  await writeFile(path.join(member.home, 'auth.json'), JSON.stringify({ ...auth, api_url: api }), { mode: 0o600, flag: 'wx' });
  check((await invoke(member, ['project', 'bind', f.projectCode])).ok, 'member_binding_failed'); return member;
}

export async function runProjectMaterialIndex(runId) {
  check(/^[A-Za-z0-9_-]{8,80}$/u.test(runId), 'bounded_unique_run_id_required');
  const dir = path.join(resultsRoot, runId); await mkdir(resultsRoot, { recursive: true }); await mkdir(dir);
  const report = { schema: 'native-project-material-index/v1', runId, startedAt: new Date().toISOString(), phase: 'preflight', accepted: false,
    realGitActions: 0, sourceScope: 'new central-55432 fixture; dedicated 18520/18524/21933 engines', modelAudit: { requestedModel: expectedModel, upstream: 'http://127.0.0.1:3425', requests: [] },
    documents: [], sessions: [], checks: {}, cleanup: { externalResourcesRemoved: false, databaseRemoved: false }, limitations: [
      'One synthetic four-material corpus and one fresh client per harness; no statistical efficiency claim.',
      'Native Magpie response model IDs attest routing, not an external provider guarantee.', 'No classifier or new code-understanding analysis is invoked.'] };
  const output = path.join(dir, 'result.json');
  report.codeHashes = Object.fromEntries(await Promise.all([
    self, cli, fileURLToPath(new URL('../dist/memory-material-runtime.js', import.meta.url)),
    fileURLToPath(new URL('../../cli/dist/memory-mcp.js', import.meta.url)),
    fileURLToPath(new URL('../../../packages/application/dist/project-material-memory.js', import.meta.url)),
  ].map(async file => [path.relative(fileURLToPath(new URL('../../../', import.meta.url)), file).replaceAll('\\', '/'), hash(await readFile(file))])));
  let saving = Promise.resolve();
  const save = () => { const snapshot = JSON.stringify(report, null, 2) + '\n'; saving = saving.then(async () => {
    await writeFile(output + '.tmp', snapshot); await rename(output + '.tmp', output); }); return saving; };
  await save();
  const corpus = corpusFor(runId);
  try {
    const { requireTestContext, assertOwnedTestDatabase } = await import('../../../scripts/test-database-guard.mjs');
    check(requireTestContext().config.port === 55432, 'central_test_cluster_required');
    const { loadMemoryEngines } = await import('../dist/memory-engines.js');
    const config = await loadMemoryEngines(enginesFile); validateConfig(config);
    const { withNativeMemoryProject, invoke } = await import('./native-memory-live.mjs');
    const { buildServer } = await import('../dist/server.js');
    const { ensureSystemAdmin } = await import('@team-synergy/application');
    process.env.TSP_MEMORY_ENABLED = '1'; process.env.ACP_ALLOW_LEGACY_IDENTITY = '0';
    await withNativeMemoryProject({ project: '资料摘要试点' }, async (f, fixture) => {
      await assertOwnedTestDatabase(f.db.$client);
      report.databaseName = (await f.db.$client.query('select current_database() as name')).rows[0].name;
      report.resourceOwnership = { project: f.projectCode, foreignProject: f.foreign.code,
        team: config.projectProvisioning.teamId, writer: config.projectProvisioning.userId };
      await save();
      const databaseUrl = f.db.$client.options.connectionString;
      check(typeof databaseUrl === 'string' && new URL(databaseUrl).hostname === '127.0.0.1' && new URL(databaseUrl).port === '55432', 'owned_fixture_connection_required');
      await ensureSystemAdmin(f.db); // Avoid logging a first-start bootstrap password in the owned server.
      const api = await buildServer({ databaseUrl, logger: false, migrate: false, memoryEnginesFile: enginesFile });
      const base = await api.listen({ host: '127.0.0.1', port: 0 });
      const http = async (method, route, member, body) => {
        const response = await fetch(base + route, { method, redirect: 'error', headers: { ...(member ? { authorization: 'Bearer ' + member.token } : {}),
          ...(route.endsWith('/memory/search') ? { 'X-TSP-Memory-Explain': '1' } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
        const envelope = await response.json();
        const rejection = /^[A-Za-z0-9_:-]{1,60}$/u.test(envelope.error?.code ?? '') ? '_' + envelope.error.code : '';
        check(response.ok && envelope.ok, 'fixture_http_' + response.status + rejection);
        if (route.endsWith('/memory/search')) report.nativeSearch = { retrieval: response.headers.get('X-TSP-Memory-Retrieval'),
          engines: response.headers.get('X-TSP-Memory-Engines'), matches: response.headers.get('X-TSP-Memory-Matches') };
        return envelope.data;
      };
      const engine = async (wiki, action, body, allowMissing = false) => {
        const endpoint = (wiki ? config.tencent.baseUrl : config.tencent.coreBaseUrl).replace(/\/$/u, '') + (wiki ? '/wiki/' : '/conversation/') + action;
        const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + config.tencent.token,
          'x-tdai-service-id': config.tencent.serviceId, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        if (allowMissing && response.status === 404) { await response.arrayBuffer(); return null; }
        const envelope = await response.json(); check(response.ok && envelope.code === 0 && envelope.data, 'test_engine_' + response.status); return envelope.data;
      };
      const bindings = () => f.db.$client.query('select p.code,b.wiki_id,b.engine_team_id as team_id,b.engine_user_id as user_id,b.semantic_agent_id,b.state,b.enabled from project_memory_bindings b join projects p on p.id=b.project_id');
      const indexes = () => f.db.$client.query(`select v.code,v.source_kind,v.object_code,v.revision_code,v.summary,v.title,v.path,j.status,j.external_ref
        from project_material_index_versions v join memory_projection_jobs j on j.material_index_id=v.id
        join projects p on p.id=v.project_id where p.code=$1 and v.active=true order by v.source_kind`, [f.projectCode]);
      try {
        report.phase = 'native_four_source_writes'; await save();
        for (const item of corpus) {
          report.phase = 'write_' + item.kind; await save();
          let created;
          if (item.kind === 'project') created = await http('POST', f.root + '/handoff/documents', f.alice, { title: item.title, kind: 'doc', summary: item.summary, content: item.body });
          else if (item.kind === 'requirement') created = await http('POST', f.root + '/requirement-documents', f.alice, { title: item.title, module_key: 'SUMMARY-PILOT', summary: item.summary, content: item.body });
          else if (item.kind === 'architecture') created = await http('POST', f.root + '/architecture-documents', f.alice, { title: item.title, summary: item.summary, content_kind: 'mermaid', source_content: 'flowchart LR\n A[读取目录] --> B[按需读取正文]', notes_markdown: item.body });
          else created = await http('POST', f.root + '/test-assets', f.alice, { title: item.title, summary: item.summary, purpose: 'guide', storage_kind: 'markdown', content: item.body });
          const catalog = await http('POST', f.root + '/materials/list', f.bob, { query: item.title });
          const row = catalog.items.find(row => row.sourceKind === item.kind && row.title === item.title);
          check(row && codePattern.test(row.sourceCitation), 'native_material_not_catalogued'); Object.assign(item, row);
          report.documents.push({ kind: item.kind, objectCode: row.objectCode, source: row.sourceCitation, revision: row.revision, title: row.title, summary: row.summary,
            bodyHash: hash(item.body.trim()), canaryHash: hash(item.marker), nativeWrite: Boolean(created) });
        }
        report.phase = 'automatic_background_projection'; await save();
        const deadline = Date.now() + 300000; let rows, binding;
        while (Date.now() < deadline) {
          rows = (await indexes()).rows; binding = (await bindings()).rows.find(row => row.code === f.projectCode);
          report.projectionProgress = { indexes: rows.map(row => ({ kind: row.source_kind, status: row.status })), bindingState: binding?.state ?? 'absent' };
          await save();
          if (rows.length === 4 && rows.every(row => row.status === 'synced') && binding?.state === 'ready' && binding.enabled) break;
          await delay(1000);
        }
        check(rows?.length === 4 && rows.every(row => row.status === 'synced') && binding?.state === 'ready' && binding.enabled, 'background_projection_not_ready');
        report.binding = { project: f.projectCode, state: binding.state, enabled: binding.enabled, wikiId: binding.wiki_id };
        report.checks.automaticBindingAndFourIndexes = true; await save();
        report.phase = 'physical_engine_summary_readback';
        const owner = { wiki_id: binding.wiki_id, team_id: binding.team_id, user_id: binding.user_id };
        const detail = await engine(true, 'get', { wiki_id: binding.wiki_id });
        check(detail.name === 'tsp-memory-' + f.projectCode && detail.team_id === binding.team_id, 'foreign_wiki_identity');
        const raw = await engine(true, 'raw/ls', owner); check(Array.isArray(raw.items) && raw.items.length === 0, 'unexpected_full_raw_upload');
        const pages = await engine(true, 'page/ls', owner); check(Array.isArray(pages.items) && pages.items.length <= 100, 'bounded_owned_wiki_inventory_required');
        for (const page of pages.items) {
          check(typeof page.path === 'string', 'wiki_inventory_path_missing');
          const copy = await engine(true, 'page/read', { ...owner, refs: [page.path] });
          const text = copy.items?.find(item => item.ref === page.path)?.content;
          check(typeof text === 'string' && corpus.every(item => !text.includes(item.marker)), 'full_body_canary_in_wiki_inventory');
        }
        report.wikiPagesScanned = pages.items.length;
        report.physical = [];
        for (const row of rows) {
          const ref = 'wiki/sources/tsp-material-' + hash(f.projectCode + '/' + row.code) + '.md';
          const page = await engine(true, 'page/read', { ...owner, refs: [ref] });
          const text = page.items?.find(item => item.ref === ref)?.content;
          const core = await engine(false, 'query', { team_id: binding.team_id, user_id: binding.user_id, agent_id: binding.semantic_agent_id,
            task_id: 'tsp-wiki-' + binding.wiki_id, session_id: 'tsp-material-' + binding.wiki_id + '-' + row.code, limit: 100 });
          check(typeof text === 'string' && core.messages?.length === 1 && core.total === 1, 'physical_index_missing');
          for (const material of corpus) check(!text.includes(material.marker) && !core.messages[0].content.includes(material.marker), 'full_body_canary_uploaded');
          check(text.includes(row.summary) && core.messages[0].content.includes(row.summary), 'summary_copy_missing');
          report.physical.push({ kind: row.source_kind, wikiBytes: Buffer.byteLength(text), coreBytes: Buffer.byteLength(core.messages[0].content), canaryAbsent: true, sourceOnlyMetadata: true });
        }
        report.checks.physicalCoreWikiExcludeFullBodyCanaries = true; await save();
        report.phase = 'short_card_and_live_body';
        const search = await http('POST', f.root + '/memory/search', f.bob, { query: '资料摘要试点', scope: 'project' });
        const cards = search.filter(row => row.sourceKind === 'project_material');
        check(corpus.every(item => cards.some(card => card.source === item.sourceCitation && card.state === 'documented' && card.locator?.sourceCitation === item.sourceCitation)) &&
          cards.every(card => corpus.every(item => !card.text.includes(item.marker))), 'short_card_contract_failed');
        for (const item of corpus) {
          const body = await http('POST', f.root + '/materials/read', f.bob, { sourceCitation: item.sourceCitation });
          check(body.current && body.state === 'documented' && body.body.includes(item.marker), 'live_material_read_failed');
        }
        report.checks.shortCardThenAuthoritativeBody = true; await save();
        await withMagpie(report, save, async () => {
          const system = '你是项目成员 Agent。项目问题从已连接 MCP 获取证据，按当前问题选择记忆搜索或资料目录；标题关键词用list_project_materials的query，glob只匹配由对象编码组成的虚拟路径。摘要只是目录，缺正文细节时按需读取实时原文。引用工具返回的source修订编码，不将objectCode文档管理编码作为来源。区分资料陈述、已确认决定与实际实施结果；没有证据时明确指出。仅使用MCP，不操作文件或命令，不修改任何记录。';
          const prompt = '请核对“资料摘要试点”的项目、需求、架构、测试四类资料，查出每份文末验收标记。它们是否提供负责人确认决定和实际实现/运行测试的证据？只输出JSON：{"materials":[{"kind":"project|requirement|architecture|testing","source":"实际来源编码","marker":"原文标记"}],"documentStatus":"实际资料状态","decisionEvidence":"present或absent","implementationEvidence":"present或absent","explanation":"简要说明依据与边界"}。';
          for (const harness of ['dsh', 'opencode']) {
            report.phase = 'fresh_' + harness + '_member'; await save();
            const member = await memberFor(f, base, fixture.dir, invoke), auditFile = path.join(dir, harness + '-tools.ndjson');
            const module = await import(harness === 'dsh' ? './native-memory-dsh.mjs' : './native-memory-opencode.mjs');
            const result = await module.runCase({ member, prompt, system, mcpArgs: [self, '--relay', auditFile], dir: fixture.dir, maxTokens: 2048, turnTimeoutMs: 180000 });
            const audit = (await readFile(auditFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), parsed = parseAnswer(result.answer);
            const correct = materialAnswerFacts(parsed, corpus);
            const formatConformant = Boolean(parsed && parsed.documentStatus === 'documented' &&
              corpus.every(item => parsed.materials?.some(row => row.kind === item.kind && row.marker === item.marker)));
            const searchIndex = audit.findIndex(row => ['search_memory', 'list_project_materials', 'glob_project_materials'].includes(row.tool) &&
              row.rows.some(item => item.state === 'documented' && kinds.includes(item.kind) && !item.bodyChars));
            const reads = audit.filter((row, index) => index > searchIndex && row.tool === 'read_project_material' && !row.error);
            const traced = searchIndex >= 0 && corpus.every(item => reads.some(row => row.rows.some(read => read.source === item.sourceCitation && read.bodyChars > 600)));
            report.sessions.push({ harness, emptySession: true, model: expectedModel, version: result.version, answer: result.answer, parsed, correct: Boolean(correct),
              formatConformant, shortCardThenReadTraced: traced, discoveryTool: audit[searchIndex]?.tool ?? null,
              agentUsedSemanticMemory: audit.some(row => row.tool === 'search_memory' && !row.error), calls: result.calls, auditFile: path.basename(auditFile) }); await save();
            check(correct && traced, 'member_' + harness + '_evidence_flow_failed');
          }
        });
        check(report.modelAudit.accepted, 'flash_model_audit_failed'); report.checks.twoFreshMemberAgents = true;
      } catch (error) {
        report.failure = safeFailure(error, report.phase); await save(); throw error;
      } finally {
        report.phase = 'owned_resource_cleanup'; await api.close();
        const scoped = (await bindings()).rows;
        report.cleanup.observedBindings = scoped.map(row => ({ project: row.code, wikiId: row.wiki_id, state: row.state }));
        await save();
        check(scoped.every(row => row.state === 'ready' && row.wiki_id), 'uncertain_binding_cleanup_requires_review');
        for (const binding of scoped.filter(row => row.wiki_id)) {
          check([f.projectCode, f.foreign.code].includes(binding.code), 'unexpected_fixture_project');
          const detail = await engine(true, 'get', { wiki_id: binding.wiki_id });
          check(detail.name === 'tsp-memory-' + binding.code && detail.team_id === binding.team_id, 'refuse_foreign_cleanup');
          const jobs = (await f.db.$client.query(`select v.code from project_material_index_versions v join projects p on p.id=v.project_id where p.code=$1`, [binding.code])).rows;
          for (const job of jobs) {
            const scope = { team_id: binding.team_id, user_id: binding.user_id, agent_id: binding.semantic_agent_id, task_id: 'tsp-wiki-' + binding.wiki_id,
              session_id: 'tsp-material-' + binding.wiki_id + '-' + job.code };
            const records = await engine(false, 'query', { ...scope, limit: 100 });
            if (records.messages?.length) {
              check(records.total === records.messages.length && records.messages.every(row => row.id && row.content.includes('[tsp-material-index ' + binding.wiki_id + ' ' + job.code + ']')), 'refuse_foreign_core_cleanup');
              await engine(false, 'delete', { ...scope, message_ids: records.messages.map(row => row.id) });
              check((await engine(false, 'query', { ...scope, limit: 100 })).total === 0, 'core_cleanup_not_verified');
            }
          }
          const deleted = await engine(true, 'delete', { wiki_ids: [binding.wiki_id] }); check(deleted.deleted_ids?.includes(binding.wiki_id), 'wiki_cleanup_not_verified');
          check(await engine(true, 'get', { wiki_id: binding.wiki_id }, true) === null, 'wiki_deletion_readback_failed');
        }
        report.cleanup.externalResourcesRemoved = true; await save();
      }
    });
    report.cleanup.databaseRemoved = true;
    report.accepted = Object.values(report.checks).every(Boolean) && Object.keys(report.checks).length === 4 && report.modelAudit.accepted;
  } catch (error) { report.failure ??= safeFailure(error, report.phase); }
  report.phase = report.accepted ? 'complete' : 'failed'; report.endedAt = new Date().toISOString(); await save();
  await writeFile(path.join(dir, 'model-audit.json'), JSON.stringify(report.modelAudit, null, 2) + '\n');
  await writeFile(path.join(dir, 'README.md'), '# 项目资料摘要索引真实验证\n\n运行：`' + runId + '`；结果：**' + (report.accepted ? 'PASS' : 'FAIL') + '**。\n\n' +
    '本轮仅使用中央55432新fixture、专用18520/18524/21933引擎，以及本机Magpie Flash。独立新DSH/OpenCode客户端经同一MCP检索短卡并按需读取正文；真实结果见 [result.json](result.json) 与 [模型审计](model-audit.json)。\n\n' +
    '失败阶段与错误码保留，不跳过失败步骤，不把索引同步当作负责人确认或实现完成。模型返回字段和工具轨迹采用自动断言，N=1/客户端，不代表长期效果或人工成员实测。\n');
  return { report, output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === '--relay') await relay(process.argv[3]);
  else {
    const { values } = parseArgs({ options: { check: { type: 'boolean', default: false }, run: { type: 'boolean', default: false }, 'run-id': { type: 'string' } } });
    check(values.check !== values.run, 'choose_check_or_run');
    if (values.check) {
      const corpus = corpusFor('offline-check'); check(corpus.length === 4 && corpus.every(item => item.body.length > 1600 && item.summary.length <= 600 && !item.summary.includes(item.marker)), 'offline_corpus_invalid');
      check((await stat(enginesFile)).isFile() && (await stat(cli)).isFile(), 'required_fixture_files_missing');
      const dsh = process.env.TSP_PROBE_DSH_BIN || path.join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
      const opencode = process.env.TSP_PROBE_OPENCODE || path.join(process.env.APPDATA || '', 'npm/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe');
      check((await stat(dsh)).isFile() && (await stat(opencode)).isFile(), 'member_harness_files_missing');
      const manifest = JSON.parse(await readFile(path.resolve(path.dirname(dsh), '../package.json'), 'utf8'));
      check(manifest.name === '@deepseek-ai/dsh' && manifest.version === '0.2.1-rc.2', 'pinned_dsh_required');
      const engines = await import('../dist/memory-engines.js'), materials = await import('../dist/memory-material-runtime.js');
      check(typeof engines.loadMemoryEngines === 'function' && typeof materials.maintainProjectMaterialIndexes === 'function', 'compiled_projection_interface_missing');
      console.log(JSON.stringify({ offlineOnly: true, serviceRequests: 0, modelRequests: 0, databaseRequests: 0, corpusKinds: kinds,
        expectedModel, requiredEnginePorts: [18520, 18524, 21933], harnessFilesPresent: true, sharedMcpCommand: 'tsp mcp', entrypointRequiresExplicitRun: true }));
    } else {
      const runId = values['run-id'] ?? new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + randomBytes(5).toString('hex');
      const { report, output } = await runProjectMaterialIndex(runId);
      console.log(JSON.stringify({ accepted: report.accepted, output, failure: report.failure ?? null, checks: report.checks, cleanup: report.cleanup }));
      if (!report.accepted) process.exitCode = 1;
    }
  }
}
