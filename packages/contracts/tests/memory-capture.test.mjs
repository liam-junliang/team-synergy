import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCaptureInput } from '../dist/index.js';

const bare = { sessionId: 'session', eventId: 'event', sourceText: '先讨论项目背景。' };
const binding = { topicCode: '0123456789ABCDEFGHJK', requirementCode: '0123456789ABCDEFGHJM', expectedHead: null, expectedRevision: 1 };

test('capture supports project/session provenance without requirement binding', () => {
  assert.equal(MemoryCaptureInput.safeParse(bare).success, true);
  assert.equal(MemoryCaptureInput.safeParse({ ...bare, ...binding }).success, true);
});

test('capture rejects every incomplete requirement/version binding', () => {
  for (const missing of Object.keys(binding)) {
    const partial = { ...bare, ...binding }; delete partial[missing];
    assert.equal(MemoryCaptureInput.safeParse(partial).success, false, missing);
  }
  assert.equal(MemoryCaptureInput.safeParse({ ...bare, expectedHead: null }).success, false);
});
