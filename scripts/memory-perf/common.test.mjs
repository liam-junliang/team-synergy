import assert from 'node:assert/strict';
import { test } from 'node:test';
import { percentile, latencyStats, summarizeSamples, runClosedLoop, measurePhase } from './common.mjs';

test('nearest-rank quantiles preserve samples and separate slow failures from successful latency', () => {
  const values = [100, 2, 1, 3];
  assert.equal(percentile(values, 0.5), 2);
  assert.equal(percentile(values, 0.95), 100);
  assert.deepEqual(values, [100, 2, 1, 3]);
  assert.equal(latencyStats([]).p95, null);
  const stats = summarizeSamples([{ ok: true, durationMs: 1 }, { ok: true, durationMs: 2 },
    { ok: false, durationMs: 100, errorCode: 'TimeoutError' }], 200);
  assert.equal(stats.latencyMs.all.p95, 100);
  assert.equal(stats.latencyMs.success.p95, 2);
  assert.equal(stats.throughput.successfulRps, 10);
  assert.equal(stats.throughput.attemptedRps, 15);
  assert.equal(stats.errors.TimeoutError, 1);
});

test('closed-loop respects concurrency and excludes warmups while retaining failed observations safely', async () => {
  let active = 0, peak = 0, warmed = 0;
  const events = [];
  const phase = await measurePhase({ engine: 'fixture', name: 'mixed', concurrency: 3, samples: 7, warmup: 2,
    phaseHook: event => events.push(event), operation: async (index, _worker, { warmup }) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      if (warmup) { warmed++; return {}; }
      if (index === 4) throw Object.assign(Error('private-body-token'), { status: 503 });
      return { status: 200, verified: true, privateBody: 'never-export' };
    } });
  assert.equal(warmed, 2); assert.equal(peak, 3);
  assert.equal(phase.summary.total, 7); assert.equal(phase.summary.failed, 1);
  assert.deepEqual(events.map(event => event.state), ['start', 'end']);
  assert.ok(!JSON.stringify(phase).includes('private-body-token'));
  assert.ok(!JSON.stringify(phase).includes('never-export'));
});

test('deadline reports missing samples without fabricating zero-duration failures', async () => {
  const phase = await measurePhase({ engine: 'fixture', name: 'deadline', concurrency: 1, samples: 100,
    warmup: 0, maxDurationMs: 1, operation: async () => { await new Promise(resolve => setTimeout(resolve, 4)); return {}; } });
  assert.equal(phase.summary.truncated, true);
  assert.equal(phase.summary.total, 1);
  assert.equal(phase.summary.notStarted, 99);
  assert.equal(phase.summary.failed, 0);
  assert.equal((await runClosedLoop({ concurrency: 1, count: 0, operation: async () => ({}) })).length, 0);
});
