import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTestAsset } from '../dist/testing-content.js';

test('file validation accepts exactly 6 MiB without regex stack overflow and rejects excess', () => {
  const file = { file_name: 'boundary.bin', mime_type: 'application/octet-stream', content_base64: Buffer.alloc(6 * 1024 * 1024, 5).toString('base64') };
  assert.equal(normalizeTestAsset({ title: 'Boundary', storage_kind: 'file', file }).file.size_bytes, 6 * 1024 * 1024);
  assert.throws(() => normalizeTestAsset({ title: 'Too large', storage_kind: 'file', file: { ...file, content_base64: Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64') } }), error => error.code === 'testing_invalid');
});
test('file validation rejects invalid encoding, path names, mismatched hashes and unsafe external URLs', () => {
  const file = { file_name: 'data.txt', content_base64: 'YWJj', mime_type: 'text/plain' };
  for (const fields of [{ file_name: '../secret.txt' }, { content_base64: 'YWJj!' }, { content_base64: 'AB==' }, { sha256: 'wrong' }, { size_bytes: 7 }]) {
    assert.throws(() => normalizeTestAsset({ title: 'Invalid', storage_kind: 'file', file: { ...file, ...fields } }), error => error.code === 'testing_invalid');
  }
  for (const url of ['javascript:alert(1)', 'https://user:secret@example.com/private']) assert.throws(() => normalizeTestAsset({ title: 'Invalid', storage_kind: 'url', url }), error => error.code === 'testing_invalid');
});
