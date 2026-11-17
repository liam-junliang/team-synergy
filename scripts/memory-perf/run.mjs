// Reproducible, opt-in local workload. Never migrates a database or changes service settings.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startObserver, discoverWindowsTargets, loadJson } from './observe.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2), options = {};
while (args.length) { const flag = args.shift(); assert.ok(['--engine', '--profile', '--run-id', '--index-timeout-ms'].includes(flag) && args.length); options[flag.slice(2)] = args.shift(); }
const engine = options.engine, profile = options.profile ?? 'baseline';
assert.ok(['tencent', 'openviking'].includes(engine) && ['smoke', 'baseline'].includes(profile), 'Choose --engine and --profile');
const indexBootstrapTimeoutMs = Number(options['index-timeout-ms'] ?? 15000);
assert.ok(Number.isSafeInteger(indexBootstrapTimeoutMs) && indexBootstrapTimeoutMs >= 1000 && indexBootstrapTimeoutMs <= 600000);
assert.ok(!options['index-timeout-ms'] || engine === 'openviking', 'Index observation deadline only applies to OpenViking');
const runId = options['run-id'] ?? new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 14) + '-' + randomBytes(5).toString('hex');
assert.match(runId, /^[a-z0-9-]{8,48}$/iu);
const outputDir = path.join(root, 'docs/experiments/memory-performance', runId, engine);
await mkdir(outputDir, { recursive: true });
const runtime = process.env.TSP_PILOT_RUNTIME ?? 'F:/workspace/team-knowledge-runtime';
const hub = process.env.TSP_PILOT_HUB ?? 'F:/workspace/team-knowledge-hub';
const tencent = await loadJson(path.join(runtime, 'tencent/deployment.json'));
const viking = await loadJson(path.join(runtime, 'openviking/deployment.json'));
const ovConfig = await loadJson(path.join(runtime, 'openviking/ov.conf'));
const gateway = await loadJson(path.join(runtime, 'tencent/gateway.json'));
const profiles = { tencent, viking };
const { attestTarget, checkOpenVikingOwnership } = await import(pathToFileURL(path.join(hub, 'scripts/setup-teamsynergy-study.mjs')));
await attestTarget({ runtime, profiles }, 'tencent');
await checkOpenVikingOwnership({ runtime, profiles });
const ports = [new URL(tencent.coreBaseUrl).port, new URL(tencent.knowledgeBaseUrl).port, new URL(viking.baseUrl).port].map(Number);
const listeners = await discoverWindowsTargets(ports);
assert.ok(listeners.length >= ports.length && listeners.every(row => row.LocalAddress === '127.0.0.1'), 'Unexpected local listeners');
const numeric = value => Number.isFinite(value) ? value : null;
const fingerprint = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const environment = { capturedAt: new Date().toISOString(), engine, profile, runId,
  host: { platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version,
    cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() },
  sourceCommits: { tencent: tencent.sourceCommit, openviking: viking.sourceCommit },
  configuration: { tencent: { workerConcurrency: numeric(gateway.worker?.concurrency),
    llmModel: gateway.llm?.model, embeddingModel: gateway.memory?.embedding?.model,
    embeddingDimensions: numeric(gateway.memory?.embedding?.dimensions) },
  openviking: { contentBackend: ovConfig.storage?.agfs?.backend, vectorBackend: ovConfig.storage?.vectordb?.backend,
    embeddingModel: ovConfig.embedding?.dense?.model ?? ovConfig.embedding?.model,
    embeddingMaxConcurrent: numeric(ovConfig.embedding?.max_concurrent), embeddingBatchSize: numeric(ovConfig.embedding?.dense?.batch_size ?? ovConfig.embedding?.batch_size),
    vlmMaxConcurrent: numeric(ovConfig.vlm?.max_concurrent) } },
  codeHashes: Object.fromEntries(await Promise.all(['run.mjs', 'common.mjs', 'observe.mjs', 'sample-resources.ps1', engine + '.mjs']
    .map(async name => [name, await fingerprint(new URL(name, import.meta.url))]))),
  serviceConfigurationHashes: { tencent: await fingerprint(path.join(runtime, 'tencent/gateway.json')),
    openviking: await fingerprint(path.join(runtime, 'openviking/ov.conf')) },
  serviceArtifacts: { tencentKnowledgeBundleSha256: await fingerprint(path.join(runtime, 'tencent/source/MemoryKnowledge/dist/server.mjs')),
    tencentReviewedPatchHash: tencent.compatibilityHash ?? null, tencentReviewedPatches: tencent.compatibilityPatches ?? [] },
  listeners, measurement: { loadModel: 'short closed-loop concurrency; not a fixed arrival-rate saturation test',
    warmupRequestsPerPhase: 2, percentiles: 'nearest rank; small-sample p99 is exploratory',
    enginesRunSerially: true, activeBackgroundApplications: 'shared developer workstation; not an isolated production capacity claim',
    resourceSampling: '2s plus collection overhead; very short phases may have no interior sample',
    dataset: 'small synthetic Chinese software-project corpus; not a large-corpus capacity benchmark' } };
await writeFile(path.join(outputDir, 'environment.json'), JSON.stringify(environment, null, 2));
const observer = await startObserver({ outputDir, pids: listeners.map(row => row.OwningProcess),
  openviking: { baseUrl: viking.baseUrl, apiKey: viking.accounts.hubadmin?.apiKey ?? viking.accounts.alice.apiKey },
  logs: [path.join(runtime, 'tencent/logs/core.log'), path.join(runtime, 'tencent/logs/knowledge.log'),
    path.join(runtime, 'openviking/server.stdout.log'), path.join(runtime, 'openviking/server.stderr.log')] });
const phaseHook = async event => {
  await observer.phaseHook(event);
  if (event.state === 'end') process.stdout.write(JSON.stringify({ engine, phase: event.phase, concurrency: event.concurrency,
    round: event.round, durationMs: event.durationMs, failed: event.failed }) + '\n');
};
let report, failureCode;
try {
  const shared = { runId, outputDir, phaseHook, concurrency: profile === 'smoke' ? [1, 2] : [1, 4, 16],
    samples: profile === 'smoke' ? 4 : 48, rounds: profile === 'smoke' ? 1 : 2 };
  if (engine === 'tencent') {
    const { runTencentBenchmark } = await import('./tencent.mjs');
    report = await runTencentBenchmark({ ...shared, profile, runtime, hub });
  } else {
    const { runOpenVikingBenchmark } = await import('./openviking.mjs');
    report = await runOpenVikingBenchmark({ ...shared, indexBootstrapTimeoutMs, timeoutMs: profile === 'smoke' ? 30000 : 60000 });
  }
} catch (error) {
  report = error?.report;
  failureCode = /^[a-zA-Z0-9_:-]{1,100}$/u.test(error?.code ?? '') ? error.code : 'benchmark_failed';
  await writeFile(path.join(outputDir, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), code: failureCode,
    message: 'Inspect the redacted engine report; raw errors and credentials are intentionally omitted.' }, null, 2));
} finally { await observer.stop(); }
assert.equal(await fingerprint(path.join(runtime, 'tencent/gateway.json')), environment.serviceConfigurationHashes.tencent);
assert.equal(await fingerprint(path.join(runtime, 'openviking/ov.conf')), environment.serviceConfigurationHashes.openviking);
await attestTarget({ runtime, profiles }, 'tencent');
await checkOpenVikingOwnership({ runtime, profiles });
process.stdout.write(JSON.stringify({ engine, profile, runId, accepted: report?.accepted ?? false,
  report: path.relative(root, path.join(outputDir, engine + '.json')), ...(failureCode ? { failureCode } : {}), cleanup: report?.cleanup }) + '\n');
if (!report?.accepted) process.exitCode = 1;
