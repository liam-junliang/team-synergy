// Opt-in real Tencent management lifecycle, fresh PostgreSQL, no agent/model run.
// Set TSP_TEST_DATABASE_URL and TSP_MEMORY_ENGINES_FILE to private local files/settings.
// node apps/core-api/tests/native-memory-management.mjs
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { withNativeMemoryProject } from './native-memory-live.mjs';
import { buildServer } from '../dist/server.js';
import { loadMemoryEngines, projectNextMemory } from '../dist/memory-engines.js';

process.env.ACP_ALLOW_LEGACY_IDENTITY = '0';
process.env.TSP_MEMORY_ENABLED = '1';
const output = new URL('../../../docs/experiments/memory-platform-rollout/management-live.json', import.meta.url);
const hash = text => createHash('sha256').update(text).digest('hex');
const report = { startedAt: new Date().toISOString(), phase: 'configuration', documents: [], deliveries: [],
  checks: {}, cleanup: { coreRecordsRemoved: false, wikiRemoved: false, isolatedDatabaseRemoved: false }, modelRuns: 0, realGitActions: 0 };
function check(condition, code) {
  if (!condition) { const error = new Error(code); error.code = code; throw error; }
}
function failure(error, phase = report.phase) {
  return { phase, name: error?.name ?? 'Error', code: typeof error?.code === 'string' && /^[a-zA-Z0-9_:-]{1,100}$/u.test(error.code) ? error.code : 'validation_failed' };
}

async function main() {
  check(Boolean(process.env.TSP_TEST_DATABASE_URL && process.env.TSP_MEMORY_ENGINES_FILE), 'private_configuration_required');
  const cfg = await loadMemoryEngines(process.env.TSP_MEMORY_ENGINES_FILE);
  check(Object.keys(cfg.projects).length === 0 && Object.keys(cfg.accounts).length === 0, 'empty_static_mappings_required');
  check(Boolean(cfg.projectProvisioning?.semanticAgentId && cfg.tencent.coreBaseUrl), 'server_provisioning_and_core_required');
  for (const endpoint of [cfg.tencent.baseUrl, cfg.tencent.coreBaseUrl]) {
    check(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname), 'only_local_engines_allowed');
  }
  report.configuration = { initialProjectMappings: 0, initialAccountMappings: 0, serverWriterConfigured: true, coreConfigured: true };
  const wiki = async (op, body, allowMissing = false) => {
    const response = await fetch(cfg.tencent.baseUrl.replace(/\/$/u, '') + '/wiki/' + op, {
      method: 'POST', headers: { authorization: 'Bearer ' + cfg.tencent.token, 'x-tdai-service-id': cfg.tencent.serviceId, 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (allowMissing && response.status === 404) return null;
    check(response.ok, 'wiki_' + op.replaceAll('/', '_') + '_http_' + response.status);
    const value = await response.json();
    check(value.code === 0, 'wiki_' + op.replaceAll('/', '_') + '_rejected');
    return value.data;
  };
  report.phase = 'fresh_database';
  let workFailure;
  await withNativeMemoryProject({ project: 'Project memory management isolated rollout' }, async f => {
    const database = (await f.db.$client.query('select current_database() as name')).rows[0].name;
    check(/^tsp_memory_live_[0-9a-f]{24}$/u.test(database), 'fresh_database_required');
    let app, binding;
    const owned = [];
    const management = f.root + '/memory/management';
    const query = '上线时怎样避免两次付款以及检查系统接力环节';
    const loadBinding = async () => (await f.db.$client.query(`select b.wiki_id,b.engine_team_id,b.engine_user_id,b.semantic_agent_id,b.generation
      from project_memory_bindings b join projects p on p.id=b.project_id where p.code=$1`, [f.projectCode])).rows[0];
    const native = async (method, url, member = f.alice, payload, explain = false) => {
      const response = await app.inject({ method, url, headers: { authorization: 'Bearer ' + member.token,
        ...(explain ? { 'x-tsp-memory-explain': '1' } : {}) }, ...(payload === undefined ? {} : { payload }) });
      check(response.statusCode === 200, 'platform_http_' + response.statusCode);
      const body = response.json(); check(body.ok === true, 'platform_envelope_rejected');
      return { data: body.data, headers: response.headers };
    };
    const action = async name => (await native('POST', management + '/' + name, f.alice, {})).data;
    const search = async () => {
      const result = await native('POST', f.root + '/memory/search', f.bob, { query, scope: 'project' }, true);
      return { data: result.data, retrieval: result.headers['x-tsp-memory-retrieval'], matches: JSON.parse(result.headers['x-tsp-memory-matches'] ?? '{}') };
    };
    const core = async (op, document, messageIds) => {
      const ids = { team_id: binding.engine_team_id, user_id: binding.engine_user_id, agent_id: binding.semantic_agent_id,
        task_id: 'tsp-wiki-' + binding.wiki_id, session_id: 'tsp-' + binding.wiki_id + '-' + document.source };
      const response = await fetch(cfg.tencent.coreBaseUrl.replace(/\/$/u, '') + '/conversation/' + op, {
        method: 'POST', headers: { authorization: 'Bearer ' + cfg.tencent.token, 'x-tdai-service-id': cfg.tencent.serviceId,
          'x-tdai-session-id': ids.session_id, 'content-type': 'application/json' },
        body: JSON.stringify({ ...ids, ...(op === 'query' ? { limit: 100 } : { message_ids: messageIds }) }),
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      check(response.ok, 'core_' + op + '_http_' + response.status);
      const body = await response.json(); check(body.code === 0, 'core_' + op + '_rejected');
      if (op === 'query') {
        check(body.data.total === body.data.messages.length, 'core_query_truncated');
        for (const row of body.data.messages) {
          check(Object.entries(ids).every(([key, value]) => row[key] === value), 'core_scope_mismatch');
          check(row.role === 'assistant' && typeof row.id === 'string' && row.content === document.text +
            '\n\n[tsp-evidence ' + binding.wiki_id + ' ' + document.source + ']', 'core_content_mismatch');
        }
      }
      return body.data;
    };
    const checkWiki = async () => {
      check(Boolean(binding?.wiki_id), 'created_wiki_not_identified');
      const detail = await wiki('get', { wiki_id: binding.wiki_id });
      check(detail.wiki_id === binding.wiki_id && detail.team_id === cfg.projectProvisioning.teamId &&
        detail.owner_user_id === cfg.projectProvisioning.userId && detail.name === 'tsp-memory-' + f.projectCode, 'wiki_ownership_mismatch');
      return detail;
    };
    const remember = async documentCode => {
      const row = (await f.db.$client.query(`select d.code as document,r.code as source,r.content,r.revision from project_documents d
        join project_document_revisions r on r.document_id=d.id and r.revision=d.revision where d.code=$1 and d.project_id=(select id from projects where code=$2)`,
      [documentCode, f.projectCode])).rows[0];
      check(Boolean(row) && row.content.length <= 4000, 'bounded_native_revision_required');
      const document = { document: row.document, source: row.source, text: row.content, revision: row.revision };
      owned.push(document);
      report.documents.push({ document: row.document, source: row.source, revision: row.revision, chars: row.content.length, sha256: hash(row.content) });
      check((await core('query', document)).total === 0, 'core_source_preexisted');
      return document;
    };
    const drain = async document => {
      const deadline = Date.now() + 480000;
      while (Date.now() < deadline) {
        const result = await projectNextMemory(f.db, cfg);
        if (!result) { await delay(1000); continue; }
        report.deliveries.push(result);
        if (result.status === 'synced') {
          check(result.source === document.source && result.semanticIndex === 'wiki_and_core', 'wrong_source_or_incomplete_projection');
          return;
        }
        check(['wiki_ingesting', 'wiki_index_pending'].includes(result.code), 'projection_not_verified');
        await delay(1000);
      }
      check(false, 'projection_deadline_exceeded');
    };
    const verifyDocument = async document => {
      const filename = 'tsp-' + document.source + '-' + hash(document.text) + '.md';
      const raw = await wiki('raw/read', { wiki_id: binding.wiki_id, filenames: [filename] });
      check(raw.items?.length === 1 && raw.items[0].content === document.text, 'wiki_full_body_mismatch');
      check((await core('query', document)).messages.length === 1, 'missing_core_record');
      const full = (await native('POST', f.root + '/memory/documents/read', f.bob, { source: document.source, offset: 0, limit: 8000 })).data;
      check(full.text === document.text && full.range.nextOffset === null, 'native_full_read_mismatch');
      const entry = report.documents.find(item => item.source === document.source);
      entry.wikiHashVerified = true; entry.coreRecordVerified = true; entry.fullNativeReadVerified = true;
    };
    const recall = async document => {
      let result;
      for (let attempt = 0; attempt < 40; attempt++) {
        result = await search();
        if (result.data.some(row => row.source === document.source) && result.matches[document.source]?.includes('core')) break;
        await delay(500);
      }
      check(!document.text.includes(query), 'semantic_query_was_literal');
      check(result.retrieval === 'engine-and-platform' && result.data.some(row => row.source === document.source && row.state === 'documented' && row.scope === 'project'), 'semantic_platform_recall_missing');
      check(result.matches[document.source]?.includes('core') && !result.matches[document.source].includes('literal'), 'core_source_attribution_missing');
      report.recalls ??= [];
      report.recalls.push({ query, source: document.source, revision: document.revision, retrieval: result.retrieval, channels: result.matches[document.source], returnedSources: result.data.map(row => row.source) });
      return result;
    };
    try {
      report.phase = 'automatic_provision';
      app = await buildServer({ db: f.db, logger: false, memoryEnginesFile: process.env.TSP_MEMORY_ENGINES_FILE });
      const initial = (await native('GET', management)).data;
      check(initial.bindingState === 'not_enabled' && initial.serviceConfigured && !initial.enabled, 'unexpected_initial_status');
      const enabled = await action('enable');
      binding = await loadBinding();
      check(enabled.bindingState === 'ready' && enabled.retrievalEnabled, 'automatic_provision_failed');
      await checkWiki();
      check(binding.engine_user_id === cfg.projectProvisioning.userId && binding.semantic_agent_id === cfg.projectProvisioning.semanticAgentId, 'persisted_writer_mismatch');
      const firstWiki = binding.wiki_id;
      check((await action('enable')).bindingState === 'ready' && (await loadBinding()).wiki_id === firstWiki, 'repeat_enable_changed_resource');
      report.checks.automaticProvisionWithoutStaticMapping = true;
      report.checks.repeatEnableReusesResource = true;

      report.phase = 'first_document_projection';
      const text = '# 支付通知幂等与发布验收\r\n\r\n第三方网关会反复发送同笔交易通知。处理入口按商户流水号设置唯一约束，重复到达仅返回此前结果，不再生成第二条订单。\r\n\r\n本次调整影响订单状态更新、消息事件投递和财务结算。部署前模拟重复通知和乱序通知，确认一笔付款只改变一次业务状态；再对订单查询与对账作业做冒烟检查。\r\n\r\n版本回退后必须复查通知去重及下游数据一致性。本文是隔离验证材料，不代表真实上线。\r\n';
      const created = await f.ok('POST', f.root + '/handoff/documents', f.alice, { title: '支付回调可靠性与上下游验收', kind: 'doc', content: text });
      const first = await remember(created.document_code);
      check((await search()).data.length === 0, 'semantic_control_already_found_source');
      report.checks.nonliteralQueryHasNoPlatformOnlyHit = true;
      await drain(first); await verifyDocument(first); await recall(first);
      report.checks.currentNativeRevisionProjectedToWikiAndCore = true;

      report.phase = 'pause_and_current_revision';
      check(!(await action('pause')).retrievalEnabled, 'pause_did_not_disable_retrieval');
      const paused = await search();
      check(paused.retrieval === 'platform' && paused.data.length === 0, 'paused_semantic_retrieval_remained_active');
      await f.ok('PATCH', '/handoff-documents/' + created.document_code, f.alice, { title: '支付回调可靠性与上下游验收',
        content: first.text + '\n\n修订验收：发生对账延迟时交由人工核对，不能用重复入账补偿；恢复之后重新执行去重和结算检查。', change_summary: '增加对账延迟验收', base_revision: 1 });
      const second = await remember(created.document_code);
      check(await projectNextMemory(f.db, cfg) === null, 'paused_worker_claimed_job');
      const queued = (await f.db.$client.query(`select j.status,j.attempts from memory_projection_jobs j
        join project_document_revisions r on r.id=j.project_document_revision_id where r.code=$1`, [second.source])).rows[0];
      check(queued?.status === 'pending' && queued.attempts === 0, 'paused_job_attempt_changed');
      report.checks.pauseFallsBackToPlatform = true; report.checks.pausePreventsClaims = true;

      report.phase = 'resume_and_application_restart';
      check((await action('enable')).retrievalEnabled && (await loadBinding()).wiki_id === firstWiki, 'resume_changed_resource');
      await app.close(); app = undefined;
      app = await buildServer({ db: f.db, logger: false, memoryEnginesFile: process.env.TSP_MEMORY_ENGINES_FILE });
      const restored = (await native('GET', management)).data;
      check(restored.bindingState === 'ready' && restored.retrievalEnabled && restored.counts.pending === 1 && (await loadBinding()).wiki_id === firstWiki, 'persisted_binding_not_restored');
      check(Object.keys(cfg.projects).length === 0, 'static_mapping_was_added');
      await drain(second); await verifyDocument(second);
      const current = await recall(second);
      check(!current.data.some(row => row.source === first.source), 'superseded_revision_recalled');
      report.checks.resumeReusesOriginalWiki = true; report.checks.newApplicationRestoresPersistentBinding = true;
      report.checks.currentRevisionOnly = true; report.checks.authoritativeBodiesRemainInPostgres = true;
    } catch (error) { workFailure = error; report.failure = failure(error); }
    finally {
      if (app) await app.close();
      report.phase = 'verified_external_cleanup';
      binding ??= await loadBinding();
      if (binding?.wiki_id) {
        try {
          await checkWiki();
          let removed = 0;
          for (const document of owned) {
            const records = (await core('query', document)).messages;
            if (!records.length) continue;
            const deleted = await core('delete', document, records.map(row => row.id));
            check(deleted.deleted_count === records.length && (await core('query', document)).total === 0, 'core_cleanup_not_verified');
            removed += records.length;
          }
          report.cleanup.coreRecordsRemoved = true; report.cleanup.coreRecordCount = removed;
        } catch (error) { report.cleanup.coreFailure = failure(error, 'core_cleanup'); }
        try {
          await checkWiki();
          const files = (await wiki('raw/ls', { wiki_id: binding.wiki_id })).items;
          const expected = new Map(owned.map(document => ['tsp-' + document.source + '-' + hash(document.text) + '.md', document.text]));
          check(Array.isArray(files) && files.every(file => expected.has(file.filename)), 'unexpected_wiki_sources_refuse_cleanup');
          if (files.length) {
            const originals = (await wiki('raw/read', { wiki_id: binding.wiki_id, filenames: files.map(file => file.filename) })).items;
            check(originals.length === files.length && originals.every(file => file.content === expected.get(file.filename)), 'wiki_cleanup_body_mismatch');
          }
          const removed = await wiki('delete', { wiki_ids: [binding.wiki_id] });
          check(removed.deleted_ids?.length === 1 && removed.deleted_ids[0] === binding.wiki_id, 'wiki_cleanup_not_verified');
          check(await wiki('get', { wiki_id: binding.wiki_id }, true) === null, 'wiki_still_present_after_cleanup');
          report.cleanup.wikiRemoved = true;
        } catch (error) { report.cleanup.wikiFailure = failure(error, 'wiki_cleanup'); }
      } else report.cleanup.wikiFailure = { phase: 'wiki_cleanup', code: 'created_resource_not_identified' };
    }
  });
  report.cleanup.isolatedDatabaseRemoved = true;
  if (workFailure) throw workFailure;
  check(report.cleanup.coreRecordsRemoved && report.cleanup.wikiRemoved, 'external_cleanup_incomplete');
}

try { await main(); report.accepted = true; }
catch (error) { report.accepted = false; report.failure ??= failure(error); process.exitCode = 1; }
report.phase = report.accepted ? 'complete' : report.failure?.phase ?? report.phase;
report.endedAt = new Date().toISOString();
await mkdir(new URL('./', output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ accepted: report.accepted, checks: report.checks, cleanup: report.cleanup, output: fileURLToPath(output), failure: report.failure }));
