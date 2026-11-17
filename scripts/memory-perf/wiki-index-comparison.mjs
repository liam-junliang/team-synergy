import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { latencyStats } from './common.mjs';

const PREFIX = 'tsp-wiki-index-micro-';
const DEFAULT_SOURCE = 'F:/workspace/team-knowledge-runtime/tencent/source/MemoryKnowledge';
const hash = value => createHash('sha256').update(value).digest('hex');
const objectHash = value => hash(JSON.stringify(value));
const rounded = value => Math.round(value * 1000) / 1000;

export function comparisonStats(durations) {
  if (durations.some(value => !Number.isFinite(value) || value < 0)) throw Error('Invalid durations');
  const sum = durations.reduce((a, b) => a + b, 0);
  return { ...latencyStats(durations), summedDurationMs: rounded(sum),
    serialOperationsPerSecond: sum > 0 ? rounded(durations.length * 1000 / sum) : null };
}

export function assertOwnedTempRoot(root) {
  if (!isAbsolute(root) || root !== resolve(root)) throw Error('Temporary cleanup requires a canonical absolute path');
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !new RegExp('^' + PREFIX + '[A-Za-z0-9]+$').test(basename(root))) {
    throw Error('Refusing cleanup of unowned temporary directory');
  }
  if (realpathSync.native(dirname(root)) !== realpathSync.native(tmpdir())
    || realpathSync.native(root) !== root) throw Error('Temporary cleanup escaped the intended parent');
  return root;
}

export function removeOwnedTempRoot(root) {
  assertOwnedTempRoot(root);
  rmSync(root, { recursive: true });
  if (existsSync(root)) throw Error('Temporary cleanup did not complete');
}

// Public synthetic software-development prose; no conversations or business data.
function document(index, scale, revision = 0) {
  const id = String(index).padStart(4, '0');
  const next = String((index + 1 + revision % 2) % scale).padStart(4, '0');
  const titleTarget = String((index + 3) % scale).padStart(4, '0');
  return `---\ntype: concept\ntitle: 公开测试条目 ${id}\nlocked: true\n---\n\n# 公开测试条目 ${id}\n\n`
    + `确定性修订序号：${revision}。项目已确认退款超过七天需要人工审核，方案尚未落实，不得把确认方案视为实际完成。\n`
    + '上游订单服务提供业务流水号，下游财务服务消费审核结果。修复重复扣款需要校验事务幂等性，并验证重复回调不会重复执行。\n'
    + '测试覆盖正常退款、边界时间、重复请求、并发请求与失败回滚。验收需要列明来源、执行证据以及未覆盖范围。\n'
    + `依赖路径 [[pages/${next}]]，关联标题 [[公开测试条目 ${titleTarget}]]。\n`
    + '本文只用于本机索引机制测量，公开合成正文完全可重复，不调用任何语言模型或者嵌入服务。\n';
}

function writePages(fixture, pages) {
  for (const page of pages) writeFileSync(join(fixture.wiki, page.ref), page.content, 'utf8');
}

function corpusManifest(fixture, scale) {
  return Array.from({ length: scale }, (_, index) => {
    const ref = `pages/${String(index).padStart(4, '0')}.md`;
    const content = readFileSync(join(fixture.wiki, ref));
    return { ref, bytes: content.length, sha256: hash(content) };
  });
}

function indexSnapshot(fixture, indexApi) {
  const db = indexApi.getReadDb(fixture.name, fixture.path);
  return {
    fts: db.prepare('SELECT page_id,title_tok,content_tok FROM wiki_fts ORDER BY page_id').all(),
    meta: db.prepare('SELECT * FROM page_meta ORDER BY page_id').all(),
    edges: db.prepare('SELECT * FROM graph_edge ORDER BY source_id,target_id').all(),
    rawLinks: db.prepare('SELECT * FROM page_link ORDER BY page_id,target_raw').all(),
    state: db.prepare('SELECT * FROM index_state ORDER BY key').all(),
    graph: fixture.manager.graph(fixture.name),
    searches: ['退款', '人工审核', '事务幂等性'].map(query => fixture.manager.search(fixture.name, query, 12, { hop: 1, minScore: 0 })),
  };
}

function verifyPair(fixtures, scale, indexApi) {
  const [a, b] = fixtures;
  const manifests = fixtures.map(fixture => corpusManifest(fixture, scale));
  assert.deepEqual(manifests[0], manifests[1], 'Both mechanisms must receive byte-identical final files');
  const snapshots = fixtures.map(fixture => indexSnapshot(fixture, indexApi));
  assert.deepEqual(snapshots[0], snapshots[1], 'Full and incremental FTS/meta/raw-link/graph/search state must agree');
  assert.equal(snapshots[0].meta.length, scale);
  assert.ok(snapshots[0].edges.length > 0);
  assert.ok(snapshots[0].searches.every(search => search.results.length > 0));
  return { equivalent: true, corpusHash: objectHash(manifests[0]), files: manifests[0],
    corpusBytes: manifests[0].reduce((sum, file) => sum + file.bytes, 0),
    indexHashes: Object.fromEntries(Object.entries(snapshots[0]).map(([key, value]) => [key, objectHash(value)])),
    rows: { fts: snapshots[0].fts.length, meta: snapshots[0].meta.length,
      graphEdges: snapshots[0].edges.length, rawLinks: snapshots[0].rawLinks.length },
    fixtureNames: [a.name, b.name] };
}

/** Isolated synchronous mechanism comparison, not an HTTP/old-release A/B benchmark. */
export async function runWikiIndexComparison({ sourceRoot = DEFAULT_SOURCE, outputDir,
  scales = [64, 256], rounds = 2, samplesPerRound = 12, warmup = 2, maxDurationMs = 55000,
  progress = message => process.stdout.write(message + '\n') } = {}) {
  if (!outputDir) throw Error('An exclusive new output directory is required');
  if (!scales.every(scale => Number.isSafeInteger(scale) && scale >= 4)
    || ![rounds, samplesPerRound, warmup].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Invalid workload');
  outputDir = resolve(outputDir);
  mkdirSync(outputDir); // Refuse to overwrite a previous result.
  const started = performance.now();
  const sourcePaths = ['src/engines/wiki/manager.ts', 'src/engines/wiki/index-db.ts', 'src/logger.ts'];
  const sourceHashes = () => Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(join(sourceRoot, path)))]));
  const beforeHashes = sourceHashes();
  const report = { schema: 1, startedAt: new Date().toISOString(), accepted: false,
    methodology: { comparison: 'Current manager.sync full rebuild versus current manager.updatePages incremental update',
      limitation: 'Not an old-version causal A/B. Current full rebuild also maintains compact raw-link tables. Single-process serial local index work, hot OS cache; not HTTP concurrency capacity or SQL-only latency.',
      models: 'None: no HTTP, embeddings, ingest or chat inference', corpus: 'Deterministic public synthetic Chinese software knowledge with path/title wikilinks',
      load: 'Synchronous serial paired updates; alternating first mechanism, reversed starting order in round 2',
      indexTiming: 'manager call only, including its persist/checkpoint/connection work; file writes excluded',
      endToEndTiming: 'Same synchronous file writes plus manager call',
      throughput: 'Sample count / summed measured service time, serial equivalent operations per second',
      percentiles: 'Nearest rank, ceil(n*p)-1; raw unrounded milliseconds persisted',
      scenarios: 'Alternating same hot page and batch of four fixed pages; byte-identical revisions across mechanisms',
      durability: 'Current full rebuild NORMAL plus TRUNCATE checkpoint; incremental FULL commit without per-operation explicit TRUNCATE',
      scales, rounds, samplesPerRound, warmupPerScale: warmup, maxDurationMs },
    environment: { node: process.version, platform: platform(), release: release(), arch: process.arch,
      logicalCpus: cpus().length, cpu: cpus()[0]?.model },
    sourceHashesBefore: beforeHashes, samples: [], scales: [], cleanup: [] };
  let loader, indexApi;
  const activeFixtures = [], temporaryRoots = [];
  const previousLogLevel = process.env.LOG_LEVEL;
  try {
    process.env.LOG_LEVEL = 'error';
    const { register } = await import(pathToFileURL(join(sourceRoot, 'node_modules/tsx/dist/esm/api/index.mjs')).href);
    loader = register({ namespace: 'wiki-index-comparison-' + randomUUID(), tsconfig: join(sourceRoot, 'tsconfig.json') });
    const { createWikiSourceManager } = await loader.import(pathToFileURL(join(sourceRoot, sourcePaths[0])).href, import.meta.url);
    indexApi = await loader.import(pathToFileURL(join(sourceRoot, sourcePaths[1])).href, import.meta.url);
    for (const scale of scales) {
      const scaleStartedAt = new Date().toISOString();
      progress(`Index mechanism comparison: ${scale} pages, ${rounds} x ${samplesPerRound} measured pairs`);
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), PREFIX)));
      temporaryRoots.push(root);
      assertOwnedTempRoot(root);
      const fixtures = ['full', 'incremental'].map(mode => {
        const path = join(root, mode), wiki = join(path, 'wiki');
        mkdirSync(join(wiki, 'pages'), { recursive: true });
        const fixture = { mode, path, wiki, name: 'micro-' + randomUUID(), manager: null };
        activeFixtures.push(fixture);
        writePages(fixture, Array.from({ length: scale }, (_, index) => ({
          ref: `pages/${String(index).padStart(4, '0')}.md`, content: document(index, scale),
        })));
        fixture.manager = createWikiSourceManager(join(root, mode + '-manager'));
        assert.equal(fixture.manager.register({ name: fixture.name, path }).status, 'ready');
        return fixture;
      });
      const initial = verifyPair(fixtures, scale, indexApi);
      const measuredStart = report.samples.length;
      const applyPair = (revision, round, sample, measured) => {
        if (performance.now() - started > maxDurationMs) throw Error('Controlled comparison time budget exhausted');
        const kind = sample % 2 === 0 ? 'single_hot_page' : 'batch_four_pages';
        const changed = Array.from({ length: kind === 'single_hot_page' ? 1 : 4 }, (_, index) => ({
          ref: `pages/${String(index).padStart(4, '0')}.md`, content: document(index, scale, revision),
        }));
        const payloadHash = objectHash(changed.map(page => ({ ref: page.ref, sha256: hash(page.content) })));
        const order = (round + sample) % 2 === 1 ? fixtures : [...fixtures].reverse();
        for (const [position, fixture] of order.entries()) {
          const wall = new Date().toISOString(), begin = performance.now();
          writePages(fixture, changed);
          const indexBegin = performance.now();
          const state = fixture.mode === 'full' ? fixture.manager.sync(fixture.name)
            : fixture.manager.updatePages(fixture.name, changed.map(page => page.ref));
          const end = performance.now();
          assert.equal(state.status, 'ready');
          assert.equal(state.pageCount, scale);
          if (measured) report.samples.push({ scale, mode: fixture.mode, round, sample, kind, position,
            startedAt: wall, changedPages: changed.length, payloadHash,
            changedBytes: changed.reduce((sum, page) => sum + Buffer.byteLength(page.content), 0),
            indexDurationMs: end - indexBegin, endToEndDurationMs: end - begin, ok: true });
        }
      };
      for (let sample = 0; sample < warmup; sample++) applyPair(sample + 1, 0, sample, false);
      for (let round = 1; round <= rounds; round++) {
        for (let sample = 0; sample < samplesPerRound; sample++) applyPair(100 * round + sample, round, sample, true);
      }
      const final = verifyPair(fixtures, scale, indexApi);
      const rows = report.samples.slice(measuredStart);
      const summaries = [];
      for (const mode of ['full', 'incremental']) for (const kind of ['all', 'single_hot_page', 'batch_four_pages']) {
        const subset = rows.filter(row => row.mode === mode && (kind === 'all' || row.kind === kind));
        summaries.push({ mode, kind, indexMs: comparisonStats(subset.map(row => row.indexDurationMs)),
          endToEndMs: comparisonStats(subset.map(row => row.endToEndDurationMs)) });
      }
      report.scales.push({ scale, startedAt: scaleStartedAt, endedAt: new Date().toISOString(), initial, final, summaries });
      for (const fixture of fixtures) indexApi.evictWikiDb(fixture.name);
      removeOwnedTempRoot(root);
      temporaryRoots.splice(temporaryRoots.indexOf(root), 1);
      report.cleanup.push({ root, removed: !existsSync(root), handlesEvicted: true });
      writeFileSync(join(outputDir, 'comparison.json'), JSON.stringify(report, null, 2));
    }
    assert.deepEqual(sourceHashes(), beforeHashes, 'Frozen upstream source must stay unchanged');
    report.accepted = true;
  } catch (error) {
    report.failure = { name: error.name, message: error.message };
  } finally {
    for (const fixture of activeFixtures) indexApi?.evictWikiDb(fixture.name);
    for (const root of temporaryRoots) {
      try { removeOwnedTempRoot(root); report.cleanup.push({ root, removed: true, handlesEvicted: true }); }
      catch (error) { report.cleanup.push({ root, removed: false, error: error.message }); report.accepted = false; }
    }
    await loader?.unregister();
    if (previousLogLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = previousLogLevel;
    report.sourceHashesAfter = sourceHashes();
    report.endedAt = new Date().toISOString();
    report.totalDurationMs = performance.now() - started;
    writeFileSync(join(outputDir, 'comparison.json'), JSON.stringify(report, null, 2));
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1) throw Error('Usage: node wiki-index-comparison.mjs [new-output-directory]');
  const outputDir = args[0] ?? fileURLToPath(new URL('../../docs/experiments/memory-performance/wiki-index-comparison-' + new Date().toISOString().replace(/[-:.]/g, '') + '/', import.meta.url));
  const report = await runWikiIndexComparison({ outputDir });
  process.stdout.write(JSON.stringify({ accepted: report.accepted, samples: report.samples.length,
    durationMs: rounded(report.totalDurationMs), cleanup: report.cleanup.every(item => item.removed),
    outputDir: resolve(outputDir), ...(report.failure ? { failure: report.failure } : {}) }) + '\n');
  if (!report.accepted) process.exitCode = 1;
}
