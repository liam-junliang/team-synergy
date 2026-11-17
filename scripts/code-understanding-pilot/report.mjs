// Read-only accounting of actual request audits, including failed pilot starts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT } from './context.mjs';

export function summarizeAudits(audits) {
  const sum = select => audits.reduce((total, audit) => {
    const value = select(audit); return total + (Number.isFinite(value) ? value : 0);
  }, 0);
  const missing = select => audits.filter(audit => !Number.isFinite(select(audit))).length;
  const measured = select => ({ reported: sum(select), unknownRequests: missing(select) });
  const starts = audits.map(a => Date.parse(a.startedAt)).filter(Number.isFinite);
  const ends = audits.map(a => Date.parse(a.finishedAt)).filter(Number.isFinite);
  return { requests: audits.length, responseAccepted: audits.filter(a => a.accepted).length,
    requestElapsedMs: measured(a => a.elapsedMs),
    wallSpanMs: starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : null,
    messageBytes: measured(a => a.inputBytes), requestBytes: measured(a => a.requestBytes),
    responseBytes: measured(a => a.responseBytes), outputContentBytes: measured(a => a.outputBytes),
    promptTokens: measured(a => a.usage?.prompt_tokens), completionTokens: measured(a => a.usage?.completion_tokens),
    totalTokens: measured(a => a.usage?.total_tokens),
    reasoningTokens: measured(a => a.usage?.completion_tokens_details?.reasoning_tokens),
    cachedPromptTokens: measured(a => a.usage?.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: measured(a => a.usage?.prompt_tokens_details?.cache_write_tokens),
    failures: audits.filter(a => !a.accepted).map(a => ({ phase: a.phase, requestSha: a.requestSha, failure: a.failure })) };
}

export function reportRuns(runIds) {
  const all = [], runs = [];
  for (const id of runIds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,70}$/u.test(id)) throw new Error('Expected a run ID, not a path');
    const directory = path.join(OUTPUT, id), state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
    const audits = state.calls.map(call => {
      if (path.basename(call.audit) !== call.audit) throw new Error('Audit path boundary violation');
      const file = path.join(directory, call.audit);
      if (!fs.existsSync(file)) return { phase: call.phase, accepted: false, requestSha: call.requestSha,
        failure: { message: 'Audit missing: request status/usage unknown' } };
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    });
    all.push(...audits);
    const phases = [...new Set(audits.map(a => a.phase))];
    runs.push({ id, status: state.phase, hostFailures: state.events.filter(event => event.kind === 'failure'),
      exactRequestReplayHits: state.events.filter(event => event.kind === 'private-exact-request-hit').length,
      summary: summarizeAudits(audits), phases: Object.fromEntries(phases.map(phase => [phase, summarizeAudits(audits.filter(a => a.phase === phase))])) });
  }
  return { accounting: 'Every actual HTTP request counted once per run; exact private replays add no request. Host-stage failures remain distinct from response validation. Missing metrics are unknown, never estimated.',
    runs, allRuns: summarizeAudits(all), nativeReviewerUsage: 'unknown',
    limits: 'One bounded sample; shared generation and each review policy are separate. No end-to-end whole-repository speedup estimate.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(reportRuns(process.argv.slice(2)), null, 2));
}
