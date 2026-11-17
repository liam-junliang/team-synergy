import assert from 'node:assert/strict';
import { readProjectFixture } from './project-reader.mjs';

// Count calls without retaining URLs, headers, queries or returned text.
const native = globalThis.fetch;
let formalReads = 0;
let forbiddenTaskCalls = 0;
globalThis.fetch = (input, options) => {
  const { port, pathname } = new URL(input.url ?? input);
  if (port === '8086' && /^\/projects\/[^/]+$/.test(pathname)) formalReads++;
  if (/(?:^|\/)(?:tasks?|context)(?:\/|$)/.test(pathname)) forbiddenTaskCalls++;
  return native(input, options);
};
try {
  const decisions = await readProjectFixture({ mode: 'decisions' });
  const known = decisions.rows.find(row => row.scope === 'project');
  assert.equal(decisions.rows.length, 1);
  assert.equal(known.state, 'confirmed');
  assert.equal(known.applicability, 'listed_tasks');
  assert.equal(known.affectedTaskIds.length, 2);
  const hits = await readProjectFixture({ query: '怎样验证Base64规范化和图片编码长度边界' });
  assert.equal(hits.rows.length, 2);
  assert.deepEqual(hits.rows.find(row => row.scope === 'project'), known);
  assert.ok(hits.rows.some(row => row.scope === 'self' && row.state === 'experience'));
  const unrelated = await readProjectFixture({ query: '咖啡豆烘焙温度' });
  assert.deepEqual(unrelated.rows, []);
  await assert.rejects(readProjectFixture({ mode: 'decisions', taskId: 'injected' }));
  assert.ok(formalReads > 0);
  assert.equal(forbiddenTaskCalls, 0);
  console.log(JSON.stringify({ result: 'PASS', checkedAt: new Date().toISOString(), currentDecisions: decisions.rows.length,
    appliesToTasks: known.affectedTaskIds.length, supportedProjectRows: 1, supportedSelfRows: 1,
    negativeQueryRows: unrelated.rows.length, projectPermissionReads: formalReads, taskOrLegacyContextCalls: forbiddenTaskCalls, rejectedTaskArgument: true,
  }, null, 2));
} finally { globalThis.fetch = native; }
