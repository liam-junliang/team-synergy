import test from 'node:test';
import assert from 'node:assert/strict';
import { materialPathMatches, searchMaterialText } from '../dist/project-material-search.js';

const metadata = { sourceKind: 'project', objectCode: '00000000000000000001', path: 'project/00000000000000000001.md',
  title: '规则', sourceCitation: '00000000000000000002', revision: 1, revisionCode: '00000000000000000002' };
const input = { documents: [{ metadata, body: '中文退款\n退款超过七天人工审核\n待落实' }], pattern: '退款',
  mode: 'literal', caseSensitive: false, contextLines: 1, offset: 0, limit: 40, maxChars: 16000 };
test('glob grammar has bounded directory semantics without regex interpolation', () => {
  for (const pattern of ['**/*.md', 'project/*.md', 'project/????????????????????.md']) assert.equal(materialPathMatches(pattern, metadata.path), true);
  assert.equal(materialPathMatches('*.md', metadata.path), false);
  assert.equal(materialPathMatches('requirement/**', metadata.path), false);
  assert.equal(materialPathMatches('**/a.md', 'a.md'), true);
  assert.equal(materialPathMatches('**/a.md', 'one/two/a.md'), true);
  assert.equal(materialPathMatches('[abc]', 'a'), false, 'character classes are not part of the documented grammar');
});
test('literal and regex modes, match pagination and output budgets are explicit', async () => {
  const literal = await searchMaterialText(input);
  assert.deepEqual(literal.matches.map(row => [row.line, row.column]), [[1, 3], [2, 1]]);
  const regex = await searchMaterialText({ ...input, mode: 'regex', pattern: '退款.*审核', limit: 1 });
  assert.equal(regex.matches[0].line, 2);
  const second = await searchMaterialText({ ...input, offset: 1, limit: 1 });
  assert.equal(second.matches[0].line, 2); assert.equal(second.truncated, false);
  const budget = await searchMaterialText({ ...input, documents: [{ metadata, body: '退款'.repeat(1000) }], maxChars: 1000 });
  assert.equal(budget.truncated, true); assert.ok(JSON.stringify(budget.matches).length <= 1000);
});
test('catastrophic regular expressions are terminated off the main thread and release their slot', async () => {
  const started = performance.now();
  let ticks = 0; const timer = setInterval(() => ticks++, 10);
  try {
    await assert.rejects(searchMaterialText({ ...input, mode: 'regex', pattern: '(a+)+$',
      documents: [{ metadata, body: 'a'.repeat(40000) + '!' }] }, 200), { code: 'material_search_timeout' });
    assert.ok(ticks > 0); assert.ok(performance.now() - started < 3000);
  } finally { clearInterval(timer); }
  assert.equal((await searchMaterialText(input)).matches.length, 2);
});
