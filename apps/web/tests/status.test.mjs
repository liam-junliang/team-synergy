import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_COLUMNS, STATUS_META, isStale } from '../src/status.ts';

test('看板分组：全部任务状态被覆盖且互不重叠', () => {
  const all = new Set(Object.keys(STATUS_META));
  const grouped = new Set();
  for (const col of BOARD_COLUMNS) {
    for (const s of col.statuses) {
      assert.ok(all.has(s), `状态 ${s} 应有展示元数据`);
      assert.ok(!grouped.has(s), `状态 ${s} 不能出现在多个列`);
      grouped.add(s);
    }
  }
  for (const s of all) {
    assert.ok(grouped.has(s), `状态 ${s} 应归属某个看板列`);
  }
});

test('stale 判定（docs/16）：24h 边界', () => {
  const now = Date.parse('2026-08-13T12:00:00Z');
  assert.equal(isStale('2026-08-13T11:59:00Z', now), false, '24h 内不算停滞');
  assert.equal(isStale('2026-08-12T11:59:59Z', now), true, '超过 24h 算停滞');
  assert.equal(isStale('2026-08-12T12:00:00Z', now), false, '恰好 24h 不算停滞（严格大于）');
  assert.equal(isStale('2026-08-10T00:00:00Z', now), true);
  assert.equal(isStale(undefined, now), false);
});
