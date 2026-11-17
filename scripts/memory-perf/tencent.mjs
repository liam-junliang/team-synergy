// Real loopback Tencent baseline. Imported by the root runner; no implicit execution.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { measurePhase } from './common.mjs';

const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const safeCode = value => typeof value === 'string' && /^[a-z0-9_.:-]{1,100}$/iu.test(value) ? value : 'request_failed';
function check(condition, code) { if (!condition) throw Object.assign(Error(code), { code, safeCode: code }); }
function local(value) {
  const url = new URL(value);
  check(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash, 'loopback_endpoint_required');
  return url.href.replace(/\/+$/u, '');
}

export function createTencentPerfClient(config, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + config.token,
    'x-tdai-service-id': config.serviceId };
  const endpoints = { wiki: local(config.knowledgeBaseUrl), core: local(config.coreBaseUrl) };
  return async (kind, operation, body, { allowMissing = false } = {}) => {
    const started = performance.now();
    let response;
    try {
      response = await fetchImpl(endpoints[kind] + (kind === 'wiki' ? '/wiki/' : '/conversation/') + operation, {
        method: 'POST', headers: { ...headers, ...(kind === 'core' ? { 'x-tdai-session-id': body.session_id ?? 'benchmark-query' } : {}) },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const code = /timeout/i.test(error?.name ?? '') ? 'timeout' : 'transport_failed';
      throw Object.assign(Error('transport_failed'), { code, safeCode: code });
    }
    if (allowMissing && response.status === 404) return { status: 404, data: null, elapsedMs: performance.now() - started };
    if (!response.ok) throw Object.assign(Error('http_failed'), { code: 'http_' + response.status, safeCode: 'http_' + response.status, status: response.status });
    let envelope;
    try { envelope = await response.json(); } catch { throw Object.assign(Error('invalid_json'), { code: 'invalid_json', safeCode: 'invalid_json', status: response.status }); }
    if (envelope.code !== 0) {
      const code = 'engine_' + safeCode(String(envelope.code));
      throw Object.assign(Error('engine_rejected'), { code, safeCode: code, status: response.status });
    }
    return { status: response.status, data: envelope.data, elapsedMs: performance.now() - started };
  };
}

export function syntheticTencentDocument(runId, project, slot, revision = 0, page = false) {
  const marker = `tspperf${runId}project${project}slot${slot}`;
  const body = `# 支付幂等与上下游验收\n\n${marker}\n\n本条是隔离性能测试资料，已确认方案但尚未实施。` +
    `订单服务接受请求后，支付服务按请求幂等键去重，审核队列接收唯一事件，客服工作台显示处理状态。` +
    `验收覆盖重复付款、回滚后重放、网络超时、上下游字段兼容和项目隔离。\n版本：${revision}。\n` +
    '测试场景：发布前核对接口契约；失败后校验订单状态、支付流水和唯一工单；所有结论需关联来源。\n'.repeat(10);
  return page ? '---\ntype: source\nlocked: true\n---\n\n' + body : body;
}

/** Public query schema caps each page at 100. Never silently truncate cleanup. */
export async function collectTencentCoreRows(query, { maxRows = 4096 } = {}) {
  const rows = [], seen = new Set(); let total;
  do {
    const { data } = await query({ limit: 100, offset: rows.length });
    check(Array.isArray(data.messages) && Number.isSafeInteger(data.total) && data.total >= 0 && data.total <= maxRows, 'core_query_invalid_total');
    if (total === undefined) total = data.total;
    check(total === data.total && data.messages.length <= 100 && rows.length + data.messages.length <= total, 'core_query_changed_during_paging');
    check(data.messages.length > 0 || rows.length === total, 'core_query_empty_page');
    for (const row of data.messages) {
      check(typeof row.id === 'string' && !seen.has(row.id), 'core_query_duplicate_row'); seen.add(row.id); rows.push(row);
    }
  } while (rows.length < total);
  check(rows.length === total, 'core_cleanup_query_truncated'); return rows;
}

export function tencentPhaseSafetyStop(summary) {
  if (!summary.total) return 'no_measured_samples';
  if (summary.truncated) return 'phase_deadline_exceeded';
  return summary.failed / summary.total > 0.2 ? 'measured_error_rate_above_20_percent' : null;
}

export async function runTencentBenchmark({ runId = randomBytes(8).toString('hex'), concurrency = [1, 4, 16],
  samples = 48, rounds = 2, outputDir, phaseHook, profile = 'baseline', projectCount = profile === 'smoke' ? 2 : 4,
  corpusPerProject = profile === 'smoke' ? 4 : 16, includeWikiIngest = true,
  runtime = 'F:/workspace/team-knowledge-runtime', hub = 'F:/workspace/team-knowledge-hub',
  fetchImpl = fetch, attestImpl, timeoutMs = 30000, ingestDeadlineMs = 360000 } = {}) {
  check(/^[a-z0-9-]{8,48}$/iu.test(runId), 'invalid_run_id');
  check(outputDir && Number.isSafeInteger(samples) && samples > 0 && samples <= 512 &&
    Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 4 && Number.isSafeInteger(projectCount) && projectCount >= 2 && projectCount <= 4,
  'invalid_benchmark_options');
  check(concurrency.every(value => Number.isSafeInteger(value) && value > 0 && value <= 32), 'invalid_concurrency');
  check(Number.isSafeInteger(corpusPerProject) && corpusPerProject >= Math.max(...concurrency) && corpusPerProject <= 64, 'insufficient_member_slots');
  outputDir = resolve(outputDir); await mkdir(outputDir, { recursive: true });
  const config = await json(resolve(runtime, 'tencent/deployment.json'));
  const source = await json(resolve(hub, 'config/live.json'));
  const study = await json(resolve(runtime, 'hub/teamsynergy-study/deployment.json'));
  assert.equal(source.tencent.knowledgeBaseUrl, config.knowledgeBaseUrl);
  assert.equal(source.tencent.coreBaseUrl ?? config.coreBaseUrl, config.coreBaseUrl);
  assert.equal(source.tencent.serviceId, config.serviceId);
  assert.deepEqual(source.projects.teamsynergy, study.mapping);
  const writer = study.mapping;
  check(Boolean(writer.tencentTeamId && writer.tencentOwnerUserId && writer.memberAgents?.alice?.agentId), 'missing_service_writer');
  const attest = attestImpl ?? (await import(pathToFileURL(resolve(hub, 'scripts/setup-teamsynergy-study.mjs')))).attestTarget;
  await attest({ runtime: resolve(runtime), profiles: { tencent: config } }, 'tencent');
  const api = createTencentPerfClient(config, { fetchImpl, timeoutMs });
  const report = { engine: 'tencent', runId, profile, startedAt: new Date().toISOString(), accepted: false,
    loadModel: 'closed-loop concurrent HTTP clients; no Agent chat-model inference',
    memberModel: 'logical member streams use the existing service-owned shared-project writer; not distinct device-authenticated platform users',
    settings: { concurrency, samplesPerPhase: samples, rounds, projectCount, corpusPerProject, requestTimeoutMs: timeoutMs,
      sourceCommit: config.sourceCommit, embeddingModel: config.embedding?.model, wikiLlmModel: config.llm?.model,
      wikiIngestWorkerConcurrency: 1, concurrencyOrder: 'alternates ascending and descending by round; fixed Core seed corpus restored outside timed groups' },
    phases: [], visibility: [], isolation: [], cleanup: { wikis: [], core: [] },
    limitations: ['HTTP timings include server filesystem/SQLite work and transport; they do not isolate SQLite CPU time.',
      'Wiki raw write does not run ingestion; page writes run synchronous wiki index sync.',
      'Core task scopes share a service/team/user/agent backend; multi-project does not imply separate Core SQLite files.',
      'Warm-cache repeated and varied semantic queries are reported separately; no durability setting is changed.',
      'Core HTTP APIs do not expose whether search used vectors or FTS fallback; correlate embedding-error log deltas before claiming semantic-index success.',
      'Standalone Core can retain its append-only JSONL audit mirror; API cleanup deletes live L0/vector records, not shared audit files.'] };
  const projects = [], issued = new Map(), seedSessions = new Set(); let ordinal = 0;
  const ids = project => ({ team_id: writer.tencentTeamId, user_id: writer.tencentOwnerUserId,
    agent_id: writer.memberAgents.alice.agentId, task_id: 'tsp-perf-' + runId + '-p' + project.index });
  const wiki = (project, op, body = {}, options) => api('wiki', op,
    { wiki_id: project.wikiId, team_id: writer.tencentTeamId, user_id: writer.tencentOwnerUserId, ...body }, options);
  const core = (project, op, body = {}) => api('core', op, { ...ids(project), ...body });
  const expectedMarker = project => `tspperf${runId}project${project.index}`;
  async function ownWiki(project) {
    const row = (await wiki(project, 'get')).data;
    check(row.wiki_id === project.wikiId && row.team_id === writer.tencentTeamId && row.owner_user_id === writer.tencentOwnerUserId && row.name === project.name, 'wiki_ownership_changed');
    return row;
  }
  async function queryRows(project) {
    return collectTencentCoreRows(body => core(project, 'query', body));
  }
  function ownedCore(project, row) {
    const expected = issued.get(row.session_id);
    return expected && expected.project === project.index && expected.content === row.content &&
      row.role === 'assistant' && Object.entries(ids(project)).every(([key, value]) => row[key] === value);
  }
  async function coreWrite(project, member, label) {
    const session = `tsp-perf-${runId}-p${project.index}-m${member}-${ordinal++}`;
    const content = syntheticTencentDocument(runId, project.index, member, ordinal) + `\n会话 ${label} ${session}`;
    issued.set(session, { project: project.index, content });
    if (label === 'seed') seedSessions.add(session);
    const result = await core(project, 'add', { session_id: session, messages: [{ role: 'assistant', content }] });
    check(result.data.accepted_ids?.length === 1, 'core_add_receipt_missing');
    return { status: result.status, bytes: Buffer.byteLength(content), verified: true, session };
  }
  function verifyPageRead(project, response, slot) {
    const content = response.data.items?.[0]?.content;
    check(typeof content === 'string' && content.includes(`${expectedMarker(project)}slot${slot}`), 'wiki_read_incorrect');
    return { status: response.status, bytes: Buffer.byteLength(content), verified: true };
  }
  async function recordGeneratedPages(project) {
    const listed = (await wiki(project, 'page/ls')).data.items ?? [];
    for (let i = 0; i < listed.length; i += 20) {
      const refs = listed.slice(i, i + 20).map(item => item.path);
      const rows = (await wiki(project, 'page/read', { refs })).data.items;
      check(rows?.length === refs.length && rows.every(row => typeof row.content === 'string'), 'generated_page_unreadable');
      for (const row of rows) project.pageHashes.set(row.ref.replace(/\\/gu, '/'), sha256(row.content));
    }
  }
  async function save() { await writeFile(resolve(outputDir, 'tencent.json'), JSON.stringify(report, null, 2)); }
  async function restoreCoreSeeds(project) {
    const rows = await queryRows(project);
    check(rows.every(row => ownedCore(project, row)), 'refuse_group_cleanup_unowned_content');
    const extra = rows.filter(row => !seedSessions.has(row.session_id));
    for (let i = 0; i < extra.length; i += 100) {
      const batch = extra.slice(i, i + 100), deleted = await core(project, 'delete', { message_ids: batch.map(row => row.id) });
      check(deleted.data.deleted_count === batch.length, 'group_cleanup_count_mismatch');
    }
    check((await queryRows(project)).length === Math.min(corpusPerProject, 16), 'seed_corpus_not_restored');
    return extra.length;
  }
  async function probeCoreVisibility(project) {
    const session = `tsp-perf-${runId}-p${project.index}-probe-${ordinal++}`;
    const content = `${expectedMarker(project)}slot999\n隔离性能试验。数据库连接池耗尽时，先比较活跃连接与空闲连接，` +
      '再查未释放事务、连接泄漏和请求排队。方案已确认，尚未实施。';
    issued.set(session, { project: project.index, content });
    const began = performance.now(), submit = await core(project, 'add', { session_id: session, messages: [{ role: 'assistant', content }] });
    const acceptedAt = performance.now();
    check(submit.data.accepted_ids?.length === 1, 'probe_add_receipt_missing');
    const readback = await core(project, 'query', { session_id: session, limit: 2 });
    check(readback.data.total === 1 && readback.data.messages?.[0]?.content === content && ownedCore(project, readback.data.messages[0]), 'probe_readback_failed');
    const query = 'database connection pool exhaustion and leaked transactions';
    check(!content.toLowerCase().includes('database') && !content.toLowerCase().includes('connection'), 'probe_english_term_overlap');
    let observed = false, polls = 0, hits = 0;
    while (performance.now() - acceptedAt < 30000) {
      const result = await core(project, 'search', { query, limit: 10 }); polls++;
      hits = result.data.messages?.length ?? 0;
      if (result.data.messages?.some(row => row.content === content)) { observed = true; break; }
      await delay(500);
    }
    report.visibility.push({ operation: 'core_cross_language_probe', project: project.index, submissionMs: acceptedAt - began,
      submitToObservedMs: performance.now() - began, receiptToObservedMs: performance.now() - acceptedAt,
      exactReadbackVerified: true, crossLanguageExpectedSourceObserved: observed, pollIntervalMs: 500, polls, hits,
      englishQueryTermsAbsentFromChineseSource: true,
      inference: 'Cross-language probe supports a working vector path; public API still does not expose per-hit channel provenance.' });
    await restoreCoreSeeds(project);
  }
  async function phase(name, c, round, operation, metadata = {}) {
    const coreRowsBefore = name.startsWith('core_') ? await Promise.all(projects.map(async p => (await queryRows(p)).length)) : undefined;
    const measured = await measurePhase({ engine: 'tencent', name, concurrency: c, samples, round, warmup: 2,
      operation, metadata: { projectCount, corpusPerProject, ...(coreRowsBefore ? { coreTaskRowsBefore: coreRowsBefore } : {}), ...metadata }, phaseHook });
    if (coreRowsBefore) measured.summary.metadata.coreTaskRowsAfter = await Promise.all(projects.map(async p => (await queryRows(p)).length));
    report.phases.push(measured); await save();
    const stop = tencentPhaseSafetyStop(measured.summary);
    if (stop) {
      report.safetyStop = { reason: stop, phase: name, concurrency: c, round,
        failed: measured.summary.failed, total: measured.summary.total, truncated: measured.summary.truncated };
      await save(); check(false, 'phase_safety_stop');
    }
  }
  let failure;
  try {
    for (let index = 0; index < projectCount; index++) {
      const name = `tsp-perf-${runId}-p${index}`;
      const listed = await api('wiki', 'list', { team_id: writer.tencentTeamId, limit: 1000 });
      check(!listed.data.items?.some(row => row.name === name), 'wiki_name_preexisted');
      const created = await api('wiki', 'create', { team_id: writer.tencentTeamId, user_id: writer.tencentOwnerUserId, name });
      check(created.status === 201 && created.data.wiki_id, 'wiki_not_new');
      const project = { index, name, wikiId: created.data.wiki_id, raw: new Map(), pages: new Map(), pageHashes: new Map() };
      projects.push(project); await ownWiki(project);
      check((await queryRows(project)).length === 0, 'core_task_preexisted');
      const filename = 'bootstrap.md', text = syntheticTencentDocument(runId, index, 0);
      await wiki(project, 'raw/write', { files: [{ filename, content: text, encoding: 'utf8' }] }); project.raw.set(filename, text);
    }
    if (includeWikiIngest) {
      const startedAt = new Date().toISOString();
      await phaseHook?.({ engine: 'tencent', phase: 'wiki_ingest_visibility', state: 'start', at: startedAt, concurrency: projectCount, round: 0 });
      const ingested = await Promise.allSettled(projects.map(async project => {
        const start = performance.now(), submitted = await wiki(project, 'ingest', { on_busy: 'reject' });
        const acceptedAt = performance.now(); let polls = 0;
        while (performance.now() - start < ingestDeadlineMs) {
          const row = await ownWiki(project); polls++;
          if (row.status === 'ready') {
            report.visibility.push({ operation: 'wiki_ingest', project: project.index, submitStatus: submitted.status,
              submissionMs: acceptedAt - start, submitToReadyMs: performance.now() - start, polls,
              pollIntervalMs: 500, initialRawDocuments: 1, usesWikiLlm: true, observedReady: true });
            await recordGeneratedPages(project); return;
          }
          check(row.status !== 'failed', 'wiki_ingest_failed'); await delay(500);
        }
        throw Object.assign(Error('wiki_ingest_deadline'), { code: 'wiki_ingest_deadline', safeCode: 'wiki_ingest_deadline' });
      }));
      await phaseHook?.({ engine: 'tencent', phase: 'wiki_ingest_visibility', state: 'end', at: new Date().toISOString(), concurrency: projectCount, round: 0 });
      const failed = ingested.find(item => item.status === 'rejected');
      if (failed) throw failed.reason;
    }
    for (const project of projects) {
      for (let slot = 0; slot < corpusPerProject; slot++) {
        const filename = `slot-${slot}.md`, ref = `wiki/sources/slot-${slot}.md`;
        const raw = syntheticTencentDocument(runId, project.index, slot), page = syntheticTencentDocument(runId, project.index, slot, 0, true);
        await wiki(project, 'raw/write', { files: [{ filename, content: raw, encoding: 'utf8' }] }); project.raw.set(filename, raw);
        await wiki(project, 'page/write', { pages: [{ ref, content: page }] }); project.pages.set(ref, page); project.pageHashes.set(ref, sha256(page));
      }
      // Bounded seeds intentionally use role=assistant to avoid L1 chat-model extraction.
      for (let member = 0; member < Math.min(corpusPerProject, 16); member++) await coreWrite(project, member, 'seed');
      const rows = await queryRows(project); check(rows.length === Math.min(corpusPerProject, 16) && rows.every(row => ownedCore(project, row)), 'core_seed_readback_failed');
    }
    for (const project of projects.slice(0, 2)) await probeCoreVisibility(project);
    report.corpus = { initialWikiRawDocuments: projects.reduce((sum, p) => sum + p.raw.size, 0),
      initialWikiCanonicalPages: projectCount * corpusPerProject, initialCoreRecords: seedSessions.size,
      initialRawUtf8Bytes: projects.reduce((sum, p) => sum + [...p.raw.values()].reduce((n, value) => n + Buffer.byteLength(value), 0), 0),
      seedDocumentUtf8Bytes: Buffer.byteLength(syntheticTencentDocument(runId, 0, 0)), generatedWikiPages: projects.reduce((sum, p) => sum + p.pageHashes.size - p.pages.size, 0) };
    const semanticQuery = '怎样防止重复付款，并验证订单、支付和审核队列的上下游一致性？';
    report.groupCleanup = [];
    for (let round = 1; round <= rounds; round++) for (const c of round % 2 ? concurrency : [...concurrency].reverse()) {
      for (const spread of [false, true]) {
        const suffix = spread ? 'multi_project' : 'hot_project';
        const choose = index => projects[spread ? index % projects.length : 0];
        await phase('wiki_metadata_read_' + suffix, c, round, async i => {
          await ownWiki(choose(i)); return { status: 200, verified: true };
        });
        await phase('wiki_raw_read_' + suffix, c, round, async i => {
          const p = choose(i), slot = i % corpusPerProject;
          return verifyPageRead(p, await wiki(p, 'raw/read', { filenames: [`slot-${slot}.md`] }), slot);
        });
        await phase('wiki_raw_write_' + suffix, c, round, async (i, worker) => {
          const p = choose(i), filename = `slot-${worker}.md`, content = syntheticTencentDocument(runId, p.index, worker, round * 10000 + i);
          const result = await wiki(p, 'raw/write', { files: [{ filename, content, encoding: 'utf8' }] }); p.raw.set(filename, content);
          return { status: result.status, bytes: Buffer.byteLength(content), verified: true };
        }, { semantics: 'per-member slot overwrite; same Wiki SQLite source table in hot_project' });
        await phase('wiki_page_read_' + suffix, c, round, async i => {
          const p = choose(i), slot = i % corpusPerProject;
          return verifyPageRead(p, await wiki(p, 'page/read', { refs: [`wiki/sources/slot-${slot}.md`] }), slot);
        });
        await phase('wiki_page_write_indexed_' + suffix, c, round, async (i, worker) => {
          const p = choose(i), ref = `wiki/sources/slot-${worker}.md`, content = syntheticTencentDocument(runId, p.index, worker, round * 10000 + i, true);
          const result = await wiki(p, 'page/write', { pages: [{ ref, content }] }); p.pages.set(ref, content); p.pageHashes.set(ref, sha256(content));
          return { status: result.status, bytes: Buffer.byteLength(content), verified: true };
        }, { semantics: 'page filesystem write plus synchronous wikiMgr.sync; no LLM ingestion' });
        if (includeWikiIngest) await phase('wiki_keyword_search_' + suffix, c, round, async i => {
          const p = choose(i), result = await wiki(p, 'search', { query: `${expectedMarker(p)}slot0`, limit: 8 });
          check(result.data.results?.some(row => String(row.path).replace(/\\/gu, '/') === 'wiki/sources/slot-0.md'), 'wiki_search_missing_expected_source');
          return { status: result.status, hits: result.data.results.length, verified: true };
        }, { queryModel: 'exact unique source marker; verifies FTS lifecycle, not semantic quality' });
        await phase('core_read_' + suffix, c, round, async i => {
          const p = choose(i), result = await core(p, 'query', { limit: 20 });
          check(result.data.messages?.length && result.data.messages.every(row => ownedCore(p, row)), 'core_read_scope_mismatch');
          return { status: result.status, hits: result.data.messages.length, verified: true };
        });
        await phase('core_write_embedding_' + suffix, c, round, async (i, worker, state) => coreWrite(choose(i), worker, state.warmup ? 'warmup' : 'measured'),
          { semantics: 'one assistant message + embedding + durable L0 upsert + configured standalone audit mirror; no L1 extraction' });
        for (const varied of [false, true]) await phase(`core_search_${varied ? 'varied' : 'repeated'}_` + suffix, c, round, async (i, _worker, state) => {
          const p = choose(i), query = semanticQuery + (varied ? ` 本轮核验 ${runId}-${round}-${c}-${suffix}-p${p.index}-${i}-${state.warmup ? 'warm' : 'sample'}。` : '');
          const result = await core(p, 'search', { query, limit: 8 });
          check(result.data.messages?.length && result.data.messages.every(row => typeof row.content === 'string' && row.content.includes(expectedMarker(p))), 'core_search_scope_or_visibility_failed');
          return { status: result.status, hits: result.data.messages.length, verified: true };
        }, { queryModel: varied ? 'unique query suffix avoids exact-text query cache reuse' : 'identical warm-cache query', includesQueryEmbedding: true });
        await phase('core_mixed_80read_20write_' + suffix, c, round, async (i, worker, state) => {
          const p = choose(i);
          if (i % 5 === 0) return coreWrite(p, worker, state.warmup ? 'mixed-warmup' : 'mixed-measured');
          const result = await core(p, 'query', { limit: 20 });
          check(result.data.messages?.length && result.data.messages.every(row => ownedCore(p, row)), 'core_mixed_read_scope_mismatch');
          return { status: result.status, hits: result.data.messages.length, verified: true };
        }, { semantics: '80% exact queries, 20% assistant-message append with directly awaited embedding; no L1 extraction or pipeline worker dependency' });
        await phase('wiki_mixed_80read_20write_' + suffix, c, round, async (i, worker) => {
          const p = choose(i), filename = `slot-${worker}.md`;
          if (i % 5) return verifyPageRead(p, await wiki(p, 'raw/read', { filenames: [filename] }), worker);
          const content = syntheticTencentDocument(runId, p.index, worker, round * 10000 + i);
          const result = await wiki(p, 'raw/write', { files: [{ filename, content, encoding: 'utf8' }] }); p.raw.set(filename, content);
          return { status: result.status, bytes: Buffer.byteLength(content), verified: true };
        });
      }
      // This maintenance is outside every timed phase and prevents later
      // concurrency levels from inheriting an ever-growing Core dataset.
      for (const p of projects) report.groupCleanup.push({ round, concurrency: c, project: p.index, removed: await restoreCoreSeeds(p) });
    }
    for (const p of projects) {
      await ownWiki(p);
      for (const [filename, expected] of p.raw) {
        const row = (await wiki(p, 'raw/read', { filenames: [filename] })).data.items?.[0];
        check(row?.content === expected, 'final_raw_hash_mismatch');
      }
      for (const [ref, expected] of p.pages) check((await wiki(p, 'page/read', { refs: [ref] })).data.items?.[0]?.content === expected, 'final_page_hash_mismatch');
      const foreign = projects[(p.index + 1) % projects.length];
      const searched = await core(p, 'search', { query: expectedMarker(foreign), limit: 20 });
      check((searched.data.messages ?? []).every(row => row.content.includes(expectedMarker(p)) && !row.content.includes(expectedMarker(foreign))), 'cross_project_search_leak');
      report.isolation.push({ project: p.index, foreignProject: foreign.index, crossProjectFiltered: true,
        returnedCount: searched.data.messages?.length ?? 0, finalRawHashesVerified: p.raw.size, finalPageHashesVerified: p.pages.size });
    }
    report.accepted = report.phases.every(p => p.summary.failed === 0 && !p.summary.truncated && p.summary.total === p.summary.requested && p.summary.warmup.failed === 0) &&
      report.visibility.every(row => row.operation !== 'core_cross_language_probe' || row.crossLanguageExpectedSourceObserved);
  } catch (error) {
    failure = error; report.failure = { code: safeCode(error?.code), status: error?.status };
  } finally {
    for (const p of projects) {
      try {
        const rows = await queryRows(p);
        check(rows.every(row => ownedCore(p, row)), 'refuse_core_cleanup_unowned_content');
        let removed = 0;
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100);
          const result = await core(p, 'delete', { message_ids: batch.map(row => row.id) });
          check(result.data.deleted_count === batch.length, 'core_cleanup_count_mismatch'); removed += batch.length;
        }
        check((await queryRows(p)).length === 0, 'core_cleanup_readback_failed');
        report.cleanup.core.push({ project: p.index, removed, verified: true });
      } catch (error) { report.cleanup.core.push({ project: p.index, verified: false, code: safeCode(error?.code) }); }
      try {
        await ownWiki(p);
        const raw = (await wiki(p, 'raw/ls')).data.items;
        check(raw?.length === p.raw.size && raw.every(row => p.raw.has(row.filename)), 'refuse_wiki_cleanup_unknown_raw');
        for (const [filename, text] of p.raw) check((await wiki(p, 'raw/read', { filenames: [filename] })).data.items?.[0]?.content === text, 'refuse_wiki_cleanup_changed_raw');
        // Generated pages are snapshotted once ingest completes; every later canonical page is tracked.
        if (p.pageHashes.size) {
          const listed = (await wiki(p, 'page/ls')).data.items ?? [];
          check(listed.length === p.pageHashes.size && listed.every(row => p.pageHashes.has(row.path)), 'refuse_wiki_cleanup_unknown_page');
          for (const row of listed) check(sha256((await wiki(p, 'page/read', { refs: [row.path] })).data.items?.[0]?.content ?? '') === p.pageHashes.get(row.path), 'refuse_wiki_cleanup_changed_page');
        }
        const deleted = await wiki(p, 'delete', { wiki_ids: [p.wikiId] });
        check(deleted.data.deleted_ids?.length === 1 && deleted.data.deleted_ids[0] === p.wikiId, 'wiki_cleanup_receipt_failed');
        check((await wiki(p, 'get', {}, { allowMissing: true })).status === 404, 'wiki_cleanup_readback_failed');
        report.cleanup.wikis.push({ project: p.index, verified: true });
      } catch (error) { report.cleanup.wikis.push({ project: p.index, verified: false, code: safeCode(error?.code) }); }
    }
    report.cleanup.complete = projects.length === projectCount && report.cleanup.core.every(x => x.verified) && report.cleanup.wikis.every(x => x.verified);
    report.accepted = report.accepted && report.cleanup.complete;
    report.endedAt = new Date().toISOString(); await save();
  }
  if (failure) throw Object.assign(Error('Tencent benchmark incomplete; inspect redacted report'), { code: safeCode(failure.code), report });
  return report;
}
