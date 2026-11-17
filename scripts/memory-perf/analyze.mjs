import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { summarizeSamples, latencyStats } from './common.mjs';

const directory = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Pass an engine report directory');
const json = async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
const lines = async name => (await readFile(path.join(directory, name), 'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row));
const environment = await json('environment.json');
const engine = environment.engine;
const report = await json(engine + '.json');
const resources = await lines('resources.jsonl');
const phases = report.phases.map(row => ({ summary: row.summary ?? row,
  samples: row.samples ?? report.requests.filter(sample => sample.phase === row.phase && sample.concurrency === row.concurrency && sample.round === row.round) }));

function resourcesFor(summary) {
  const begin = Date.parse(summary.startedAt), end = Date.parse(summary.endedAt);
  const inside = resources.filter(row => !row.sampleError && Date.parse(row.at) >= begin && Date.parse(row.at) <= end);
  const count = inside.length;
  const roles = { tencentCore: Number(environment.listeners.find(row => Number(row.port) === 8420)?.OwningProcess),
    tencentKnowledge: Number(environment.listeners.find(row => Number(row.port) === 8424)?.OwningProcess),
    openviking: Number(environment.listeners.find(row => Number(row.port) === 1933)?.OwningProcess) };
  const cpu = {};
  if (count >= 2) {
    const first = inside[0], last = inside.at(-1), seconds = (Date.parse(last.at) - Date.parse(first.at)) / 1000;
    for (const [role, pid] of Object.entries(roles)) {
      const a = first.processes.find(row => row.pid === pid), b = last.processes.find(row => row.pid === pid);
      cpu[role] = a && b && a.createdAt === b.createdAt && seconds > 0 ? {
        meanCoresUsed: (b.cpu100ns - a.cpu100ns) / 1e7 / seconds,
        meanMachineCpuPercent: (b.cpu100ns - a.cpu100ns) / 1e7 / seconds / environment.host.logicalProcessors * 100,
        readTransferDeltaBytes: b.readTransferBytes - a.readTransferBytes,
        writeTransferDeltaBytes: b.writeTransferBytes - a.writeTransferBytes } : null;
    }
    let total = 0, matched = 0;
    for (const b of last.processes.filter(row => row.name === 'ollama.exe')) {
      const a = first.processes.find(row => row.pid === b.pid && row.createdAt === b.createdAt);
      if (a) { total += b.cpu100ns - a.cpu100ns; matched++; }
    }
    cpu.ollama = matched && seconds > 0 ? { meanCoresUsed: total / 1e7 / seconds } : null;
  }
  const gpu = inside.flatMap(row => row.gpu ?? []);
  return { samples: count, cpu: count >= 2 ? cpu : null,
    observationCoverage: count >= 2 && end > begin ? (Date.parse(inside.at(-1).at) - Date.parse(inside[0].at)) / (end - begin) : 0,
    gpuUtilizationPercent: gpu.length ? latencyStats(gpu.map(row => row.utilizationPercent)) : null,
    gpuMemoryPeakMiB: gpu.length ? Math.max(...gpu.map(row => row.memoryUsedMiB)) : null,
    freeMemoryMinMiB: count ? Math.min(...inside.map(row => row.freeMemoryKiB / 1024)) : null };
}
const groups = new Map();
for (const phase of phases) {
  const { summary, samples } = phase;
  assert.equal(samples.length, summary.total, 'Raw sample count mismatch');
  assert.equal(samples.filter(row => row.ok).length, summary.succeeded, 'Raw success count mismatch');
  phase.resources = resourcesFor(summary);
  const key = summary.phase + '/' + summary.concurrency;
  const group = groups.get(key) ?? { phase: summary.phase, concurrency: summary.concurrency, rounds: [], samples: [], durationMs: 0, truncated: false, warmupFailures: 0 };
  group.rounds.push(summary.round); group.samples.push(...samples); group.durationMs += summary.durationMs;
  group.truncated ||= summary.truncated; group.warmupFailures += summary.warmup.failed;
  groups.set(key, group);
}
const aggregated = [...groups.values()].map(group => {
  const { samples, durationMs, ...metadata } = group;
  return { ...metadata, ...summarizeSamples(samples, durationMs) };
});
const total = aggregated.reduce((n, group) => n + group.total, 0), failed = aggregated.reduce((n, group) => n + group.failed, 0);
const analysis = { at: new Date().toISOString(), engine, runId: report.runId, accepted: report.accepted,
  ...(typeof report.contentBaselineAccepted === 'boolean' ? { contentBaselineAccepted: report.contentBaselineAccepted,
    semanticBaselineAccepted: report.semanticBaselineAccepted } : {}),
  totals: { phases: phases.length, requests: total, failed }, aggregated,
  phaseObservations: phases.map(({ summary, resources: observations }) => ({ phase: summary.phase, concurrency: summary.concurrency,
    round: summary.round, startedAt: summary.startedAt, endedAt: summary.endedAt, resources: observations })),
  interpretation: ['Latency quantiles pool same-operation, same-concurrency rounds only; successful throughput uses summed measured wall windows.',
    'No internal SQL spans were recorded. HTTP latency must not be labelled PostgreSQL/SQLite execution time.',
    'A zero resource sample count means missing temporal coverage, not zero resource usage.',
    'Two-second CPU/GPU observations are coarse and shared workstation traffic may affect them.',
    'This small-corpus test cannot determine large-corpus vector capacity or predict PG adapter performance.'] };
await writeFile(path.join(directory, 'analysis.json'), JSON.stringify(analysis, null, 2));
const rows = ['| Operation | Clients | Samples | Errors | p50 ms | p95 ms | Successful req/s |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
for (const group of aggregated) rows.push(`| ${group.phase} | ${group.concurrency} | ${group.total} | ${group.failed} | ${group.latencyMs.all.p50} | ${group.latencyMs.all.p95} | ${group.throughput.successfulRps} |`);
await writeFile(path.join(directory, 'summary.md'), `# ${engine} ${report.runId}\n\nAccepted: ${report.accepted}; requests: ${total}; errors: ${failed}.\n\n${rows.join('\n')}\n\nQuantiles include failures; p99 is exploratory. Closed-loop throughput is not a saturation capacity claim.\n`);
process.stdout.write(JSON.stringify({ engine, runId: report.runId, accepted: report.accepted, total, failed, groups: aggregated.length }) + '\n');
