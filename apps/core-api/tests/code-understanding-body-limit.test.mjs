import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { CODE_UNDERSTANDING_MAX_BYTES } from '@team-synergy/contracts';
import { registerCodeUnderstandingRoutes } from '../dist/routes/code-understanding.js';

test('code publish accepts full-repository request sizes up to the shared 32 MiB limit and rejects excess bytes', async () => {
  const app = Fastify({ logger: false });
  // Unauthenticated requests stop in the route before any database operation.
  // Reaching 401 proves the actual body parser accepted the complete byte count.
  registerCodeUnderstandingRoutes(app, null);
  const url = `/projects/${'A'.repeat(20)}/code-understanding/runs/${'B'.repeat(20)}/publish`;
  const envelope = '{"padding":""}';
  const request = bytes => app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{"padding":"' + 'x'.repeat(bytes - Buffer.byteLength(envelope)) + '"}' });
  try {
    assert.equal(CODE_UNDERSTANDING_MAX_BYTES, 32 * 1024 * 1024);
    // Measured codegraph-only projection from this repository already exceeds the former 10 MiB cap.
    assert.equal((await request(13_184_949)).statusCode, 401);
    assert.equal((await request(CODE_UNDERSTANDING_MAX_BYTES)).statusCode, 401);
    assert.equal((await request(CODE_UNDERSTANDING_MAX_BYTES + 1)).statusCode, 413);
  } finally { await app.close(); }
});
