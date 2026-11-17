import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

const round = value => Math.round(value * 1000) / 1000;
export function latencyStats(values) {
  if (!values.length) return { n: 0, mean: null, p50: null, p95: null, p99: null, max: null };
  return { n: values.length, mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)), max: round(Math.max(...values)) };
}

export function summarizeSamples(samples, durationMs) {
  const successes = samples.filter(row => row.ok), failures = samples.filter(row => !row.ok);
  const errors = {};
  for (const failure of failures) errors[failure.errorCode] = (errors[failure.errorCode] ?? 0) + 1;
  return { total: samples.length, succeeded: successes.length, failed: failures.length,
    errorRate: samples.length ? failures.length / samples.length : null,
    durationMs: round(durationMs),
    throughput: { successfulRps: durationMs > 0 ? round(successes.length * 1000 / durationMs) : null,
      attemptedRps: durationMs > 0 ? round(samples.length * 1000 / durationMs) : null },
    latencyMs: { all: latencyStats(samples.map(row => row.durationMs)),
      success: latencyStats(successes.map(row => row.durationMs)), failure: latencyStats(failures.map(row => row.durationMs)) }, errors };
}

function safeError(error) {
  // Server error bodies/messages can contain content or credentials. Persist
  // only codes deliberately supplied by this benchmark and known error types.
  const custom = error?.safeCode;
  if (typeof custom === 'string' && /^[a-zA-Z][a-zA-Z0-9_:-]{0,80}$/u.test(custom)) return custom;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return 'HTTP_' + error.status;
  return ['AbortError', 'TimeoutError', 'AssertionError', 'TypeError'].includes(error?.name) ? error.name : 'operation_failed';
}

export async function runClosedLoop({ concurrency, count, operation, warmup = false, deadline = Infinity }) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(count) || count < 0) throw Error('Invalid benchmark load');
  let next = 0;
  const rows = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async (_, workerId) => {
    while (next < count && performance.now() < deadline) {
      const index = next++;
      const startedAt = new Date().toISOString(), begin = performance.now();
      try {
        const value = await operation(index, workerId, { warmup });
        if (value?.verified === false) throw Object.assign(Error('Unverified result'), { safeCode: 'verification_failed' });
        const extras = {};
        for (const key of ['status', 'bytes', 'hits']) if (Number.isFinite(value?.[key])) extras[key] = value[key];
        if (typeof value?.verified === 'boolean') extras.verified = value.verified;
        rows.push({ sample: index, workerId, startedAt, durationMs: round(performance.now() - begin), ok: true, ...extras });
      } catch (error) {
        rows.push({ sample: index, workerId, startedAt, durationMs: round(performance.now() - begin), ok: false,
          errorCode: safeError(error), ...(Number.isInteger(error?.status) ? { status: error.status } : {}) });
      }
    }
  }));
  return rows.sort((a, b) => a.sample - b.sample);
}

/** Closed-loop client concurrency, not a fixed arrival-rate/capacity test. */
export async function measurePhase({ engine, name, concurrency, samples = 48, round: iteration = 1,
  warmup = 2, operation, metadata = {}, phaseHook, maxDurationMs = 120000 }) {
  const warmupStart = performance.now();
  const warmed = await runClosedLoop({ concurrency: Math.min(concurrency, Math.max(warmup, 1)), count: warmup, operation, warmup: true,
    deadline: warmupStart + maxDurationMs });
  const at = new Date().toISOString();
  const context = { engine, phase: name, concurrency, round: iteration };
  await phaseHook?.({ ...context, state: 'start', at });
  const eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable();
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  const rows = await runClosedLoop({ concurrency, count: samples, operation, deadline: start + maxDurationMs });
  const durationMs = performance.now() - start;
  const cpuUsed = process.cpuUsage(cpuStart); eventLoop.disable();
  const summary = { ...context, startedAt: at, endedAt: new Date().toISOString(), workload: 'closed_loop', requested: samples,
    notStarted: samples - rows.length, truncated: rows.length < samples, warmup: { attempted: warmed.length, failed: warmed.filter(row => !row.ok).length },
    ...summarizeSamples(rows, durationMs),
    client: { cpuUserMs: cpuUsed.user / 1000, cpuSystemMs: cpuUsed.system / 1000,
      eventLoopSamples: eventLoop.count, eventLoopP95Ms: eventLoop.count ? eventLoop.percentile(95) / 1e6 : null }, metadata };
  await phaseHook?.({ ...context, state: 'end', at: summary.endedAt, durationMs: summary.durationMs, failed: summary.failed });
  return { summary, samples: rows };
}
