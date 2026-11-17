// Opt-in native document write -> shared outbox -> real Tencent projection.
// node apps/core-api/tests/native-memory-document-projection.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { withNativeMemoryProject } from './native-memory-live.mjs';
import { withScratchMemoryEngines } from './native-memory-engines.mjs';
import { projectNextMemory, searchMemoryEngineDetailed } from '../dist/memory-engines.js';

process.env.ACP_ALLOW_LEGACY_IDENTITY = '0';
process.env.TSP_MEMORY_ENABLED = '1';
const output = new URL('../../../docs/experiments/memory-project-documents/projection-live.json', import.meta.url);
const hash = text => createHash('sha256').update(text).digest('hex');
const report = { startedAt: new Date().toISOString(), documents: [], deliveries: [], realGitActions: 0 };

async function main() {
  await withNativeMemoryProject({}, async f => withScratchMemoryEngines(f.db,
    { projectCode: f.projectCode, aliceCode: f.alice.code, bobCode: f.bob.code }, async ({ cfg, wiki, wikiId, profiles, mapping }) => {
      cfg.tencent.coreBaseUrl = profiles.tencent.coreBaseUrl;
      const project = cfg.projects[f.projectCode];
      project.semanticAgentId = mapping.memberAgents.alice.agentId;
      assert.ok(cfg.tencent.coreBaseUrl && project.semanticAgentId);
      const cases = [
        { id: 'short', text: '# 中文部署验收\r\n\r\n发布前核对账号隔离、回滚方案与当前项目。此文档是隔离演练，不代表真实发布。\r\n' },
        { id: 'large', text: '# 长文中文部署验收\r\n\r\n' +
          '发布前逐项验证编码、上下游接口、请求乱序以及撤权后的项目隔离。\r\n'.repeat(160) +
          '\r\n文末约束：回滚后必须再次验证；本文仅是隔离演练。\r\n' },
      ];
      assert.ok(cases[0].text.length <= 4000 && cases[1].text.length > 4000);
      const owned = [];
      async function core(op, document) {
        const ids = { team_id: project.teamId, user_id: project.userId, agent_id: project.semanticAgentId,
          task_id: 'tsp-wiki-' + wikiId, session_id: 'tsp-' + wikiId + '-' + document.source };
        const response = await fetch(cfg.tencent.coreBaseUrl.replace(/\/$/u, '') + '/conversation/' + op, {
          method: 'POST', headers: { authorization: 'Bearer ' + cfg.tencent.token, 'content-type': 'application/json',
            'x-tdai-service-id': cfg.tencent.serviceId, 'x-tdai-session-id': ids.session_id },
          body: JSON.stringify({ ...ids, ...(op === 'query' ? { limit: 100 } : { message_ids: document.recordIds }) }),
          redirect: 'error', signal: AbortSignal.timeout(15_000),
        });
        assert.equal(response.status, 200);
        const body = await response.json(); assert.equal(body.code, 0);
        if (op === 'query') {
          assert.equal(body.data.total, body.data.messages.length);
          for (const row of body.data.messages) {
            assert.ok(Object.entries(ids).every(([key, value]) => row[key] === value), 'Core identity drift');
            assert.equal(row.content, document.text + '\n\n[tsp-evidence ' + wikiId + ' ' + document.source + ']');
            assert.equal(row.role, 'assistant');
          }
        }
        return body.data;
      }
      try {
        for (const item of cases) {
          const created = await f.ok('POST', f.root + '/handoff/documents', f.alice,
            { title: '隔离文档投影 ' + item.id, kind: 'doc', content: item.text });
          const stored = await f.db.$client.query(`select v.id,v.code,v.content from project_document_revisions v
            join project_documents d on d.id=v.document_id where d.code=$1 and v.revision=1`, [created.document_code]);
          assert.equal(stored.rowCount, 1);
          // Native authoring normalizes line endings and surrounding whitespace.
          // The immutable stored revision, rather than the submitted transport
          // bytes, is the authoritative body projected without further changes.
          assert.equal(stored.rows[0].content, item.text.replaceAll('\r\n', '\n').trim());
          const queued = await f.db.$client.query('select engine,status from memory_projection_jobs where project_document_revision_id=$1', [stored.rows[0].id]);
          assert.deepEqual(queued.rows, [{ engine: 'tencent', status: 'pending' }]);
          const document = { ...item, text: stored.rows[0].content, source: stored.rows[0].code, document: created.document_code };
          assert.equal((await core('query', document)).total, 0, 'Refusing to reuse a Core source');
          owned.push(document);
          report.documents.push({ id: item.id, source: document.source, document: document.document,
            chars: document.text.length, utf8Bytes: Buffer.byteLength(document.text), sha256: hash(document.text),
            submittedSha256: hash(item.text), nativeWriterNormalized: document.text !== item.text, transactionQueued: true });
        }
        const deadline = Date.now() + 480_000;
        while (report.deliveries.filter(item => item.status === 'synced').length < cases.length && Date.now() < deadline) {
          const delivery = await projectNextMemory(f.db, cfg);
          if (!delivery || ['wiki_ingesting', 'wiki_index_pending'].includes(delivery.code)) { await delay(1000); continue; }
          report.deliveries.push(delivery);
          assert.equal(delivery.status, 'synced', 'Document delivery was not verified');
        }
        assert.equal(report.deliveries.filter(item => item.status === 'synced').length, cases.length);
        const files = (await wiki('raw/ls', { wiki_id: wikiId })).data.items;
        assert.equal(files.length, cases.length);
        for (const document of owned) {
          const filename = 'tsp-' + document.source + '-' + hash(document.text) + '.md';
          assert.ok(files.some(file => file.filename === filename));
          const raw = (await wiki('raw/read', { wiki_id: wikiId, filenames: [filename] })).data.items[0].content;
          assert.equal(hash(raw), hash(document.text), 'Full native revision hash mismatch');
          const records = (await core('query', document)).messages;
          assert.equal(records.length, document.id === 'short' ? 1 : 0);
          const entry = report.documents.find(item => item.id === document.id);
          entry.fullWikiHashVerified = true; entry.coreRecords = records.length;
          const hit = await wiki('search', { wiki_id: wikiId, query: 'tspfragment' + document.source.toLowerCase(), limit: 16 });
          assert.ok(hit.data.results.length, 'Canonical Wiki source was not indexed');
        }
        const natural = await searchMemoryEngineDetailed(cfg,
          { projectCode: f.projectCode, principalCode: f.bob.code }, '发布前中文部署验收需要核对哪些内容', 'project');
        report.naturalChinese = { wikiHits: natural.wiki.length, coreHits: natural.core.length, degraded: natural.degraded };
        assert.ok(natural.core.length, 'Short document was missing from native semantic search');
        assert.equal(await projectNextMemory(f.db, cfg), null);
      } finally {
        for (const document of owned) {
          const records = (await core('query', document)).messages;
          if (!records.length) continue;
          document.recordIds = records.map(row => row.id);
          assert.equal((await core('delete', document)).deleted_count, records.length);
          assert.equal((await core('query', document)).total, 0);
        }
      }
    }));
  report.isolatedDatabaseAndEngineResourcesRemoved = true;
}

try { await main(); report.accepted = true; }
catch (error) { report.accepted = false; report.failure = { name: error.name, message: error.message.slice(0, 1000) }; process.exitCode = 1; }
report.endedAt = new Date().toISOString();
await mkdir(new URL('./', output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ accepted: report.accepted, sources: report.documents.length, deliveries: report.deliveries,
  output: fileURLToPath(output), failure: report.failure }));
