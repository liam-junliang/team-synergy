import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedNodeContainer, waitForSelectedNode } from '../ua-reader/selection.ts';

function clock() {
  const frames = new Map(), timers = new Map(); let next = 0;
  return { frames, timers,
    requestFrame(action) { const id = ++next; frames.set(id, action); return id; },
    cancelFrame(id) { frames.delete(id); },
    schedule(action, delay) { const id = ++next; timers.set(id, { action, delay }); return id; },
    cancelScheduled(id) { timers.delete(id); },
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(action => action()); },
    flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(({ action }) => action()); },
  };
}

test('complete-system selection reveals only its real runtime container and preserves legacy/manual ungrouped behavior', () => {
  const topology = new Map([['file:src/task.ts', 'container:cluster-a'], ['module:delivery', 'container:cluster-b'], ['flow:verify', 'flow:verify']]);
  assert.equal(selectedNodeContainer('full_system', 'file:src/task.ts', topology), 'container:cluster-a');
  assert.equal(selectedNodeContainer('full_system', 'module:delivery', topology), 'container:cluster-b');
  for (const profile of ['legacy_split', undefined, 'untrusted']) assert.equal(selectedNodeContainer(profile, 'file:src/task.ts', topology), null);
  for (const node of ['flow:verify', 'missing', null]) assert.equal(selectedNodeContainer('full_system', node, topology), null);
  assert.equal(selectedNodeContainer('full_system', 'file:src/task.ts', undefined), null);
  assert.deepEqual([...topology], [['file:src/task.ts', 'container:cluster-a'], ['module:delivery', 'container:cluster-b'], ['flow:verify', 'flow:verify']]);
});

test('source-style selection waits beyond the old 100ms for asynchronous children and their real measurement before fitting', () => {
  const scheduler = clock(); let internal, fits = 0;
  const cancel = waitForSelectedNode({ nodeId: 'file:src/task.ts', getNode: id => { assert.equal(id, 'file:src/task.ts'); return internal; }, fit: () => fits++, ...scheduler });
  for (let frame = 0; frame < 45; frame++) { scheduler.frame(); scheduler.flushTimers(); }
  assert.equal(fits, 0, 'a collapsed group must never be fitted as a substitute for the selected child');
  internal = { measured: { width: 0, height: 60 } }; scheduler.frame(); assert.equal(scheduler.timers.size, 0);
  internal = { measured: { width: 220, height: 60 } }; scheduler.frame();
  assert.deepEqual([...scheduler.timers.values()].map(timer => timer.delay), [100]); assert.equal(fits, 0);
  scheduler.flushTimers(); assert.equal(fits, 1); assert.equal(scheduler.frames.size, 0);
  cancel(); scheduler.frame(); scheduler.flushTimers(); assert.equal(fits, 1);
});

test('selection changes or unmount cancel both measurement polling and a scheduled viewport move', () => {
  for (const measured of [false, true]) {
    const scheduler = clock(); let fits = 0;
    const cancel = waitForSelectedNode({ nodeId: 'file:old.ts', getNode: () => measured ? { measured: { width: 220, height: 60 } } : undefined, fit: () => fits++, ...scheduler });
    scheduler.frame(); cancel(); scheduler.frame(); scheduler.flushTimers(); assert.equal(fits, 0); assert.equal(scheduler.frames.size, 0); assert.equal(scheduler.timers.size, 0);
  }
});

test('a temporarily withdrawn child is remeasured and a permanently filtered target never fits an empty cluster', () => {
  const scheduler = clock(); let internal = { measured: { width: 220, height: 60 } }, fits = 0;
  waitForSelectedNode({ nodeId: 'file:src/task.ts', getNode: () => internal, fit: () => fits++, ...scheduler });
  scheduler.frame(); internal = undefined; scheduler.flushTimers(); assert.equal(fits, 0);
  internal = { measured: { width: 220, height: 60 } }; scheduler.frame(); scheduler.flushTimers(); assert.equal(fits, 1);
  const missing = clock(); let fallbacks = 0;
  waitForSelectedNode({ nodeId: 'file:hidden.ts', getNode: () => undefined, fit: () => fallbacks++, ...missing });
  for (let frame = 0; frame < 241; frame++) missing.frame();
  assert.equal(missing.frames.size, 0); assert.equal(missing.timers.size, 0); assert.equal(fallbacks, 0);
});
