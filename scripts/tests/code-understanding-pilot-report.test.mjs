import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAudits } from '../code-understanding-pilot/report.mjs';

test('request accounting includes failed requests and keeps absent metrics unknown', () => {
  const result = summarizeAudits([
    { accepted: true, phase: 'task', elapsedMs: 10, inputBytes: 200,
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
        completion_tokens_details: { reasoning_tokens: 5 } } },
    { accepted: false, phase: 'reviewA', elapsedMs: 60, inputBytes: 300, failure: { message: 'timeout' } },
  ]);
  assert.equal(result.requests, 2);
  assert.equal(result.responseAccepted, 1);
  assert.deepEqual(result.requestElapsedMs, { reported: 70, unknownRequests: 0 });
  assert.deepEqual(result.messageBytes, { reported: 500, unknownRequests: 0 });
  assert.deepEqual(result.totalTokens, { reported: 120, unknownRequests: 1 });
  assert.deepEqual(result.reasoningTokens, { reported: 5, unknownRequests: 1 });
  assert.equal(result.failures[0].phase, 'reviewA');
  assert.equal(result.wallSpanMs, null);
});

test('reasoning tokens remain a subset rather than being added to total tokens', () => {
  const result = summarizeAudits([{ accepted: true, usage: { prompt_tokens: 10, completion_tokens: 8,
    total_tokens: 18, completion_tokens_details: { reasoning_tokens: 5 },
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }]);
  assert.equal(result.totalTokens.reported, 18);
  assert.equal(result.reasoningTokens.reported, 5);
  assert.deepEqual(result.cachedPromptTokens, { reported: 0, unknownRequests: 0 });
});
