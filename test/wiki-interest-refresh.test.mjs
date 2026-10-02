import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshController } from '../src/refresh-controller.js';

function fixture(load) {
  let tick, visible = true, cancelled = false;
  const controller = createRefreshController({ load, intervalMs: 3600000, isVisible: () => visible,
    schedule(fn, ms) { assert.equal(ms, 3600000); tick = fn; return 1; }, cancel() { cancelled = true; } });
  return { controller, tick: () => tick(), hide() { visible = false; }, get cancelled() { return cancelled; } };
}
test('hourly and return checks respect pause and visibility; manual refresh remains available', async () => {
  let calls = 0;
  const f = fixture(async ({ canApply }) => { assert(canApply()); calls++; });
  await f.tick(); assert.equal(calls, 1);
  f.controller.setPaused(true);
  await f.tick(); await f.controller.request('automatic'); assert.equal(calls, 1);
  await f.controller.request(); assert.equal(calls, 2);
  await f.controller.setPaused(false); assert.equal(calls, 3);
  f.hide(); await f.tick(); assert.equal(calls, 3);
  f.controller.dispose(); await f.controller.request(); assert.equal(calls, 3); assert(f.cancelled);
});
test('pausing invalidates an in-flight automatic result, resume queues exactly one fresh request', async () => {
  let release, calls = 0;
  const applied = [];
  const f = fixture(async ({ canApply }) => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    applied.push(canApply());
  });
  const running = f.tick();
  await f.tick(); assert.equal(calls, 1);
  f.controller.setPaused(true);
  f.controller.setPaused(false);
  f.controller.request();
  assert.equal(calls, 1);
  release(); await running;
  assert.deepEqual(applied, [false, true]); assert.equal(calls, 2); assert(!f.controller.busy);
});
test('pausing does not invalidate an explicitly requested refresh', async () => {
  let release, applied;
  const f = fixture(async ({ canApply }) => { await new Promise(resolve => { release = resolve; }); applied = canApply(); });
  const running = f.controller.request();
  f.controller.setPaused(true); release(); await running;
  assert.equal(applied, true);
});
test('pausing again invalidates a resume-triggered request and cancels queued resumes', async () => {
  let release, applied, calls = 0;
  const f = fixture(async ({ canApply }) => { calls++; await new Promise(resolve => { release = resolve; }); applied = canApply(); });
  f.controller.setPaused(true);
  const running = f.controller.setPaused(false);
  f.controller.setPaused(true); f.controller.setPaused(false); f.controller.setPaused(true);
  release(); await running;
  assert.equal(applied, false); assert.equal(calls, 1); assert(!f.controller.busy);
});
test('a failed request clears the busy flag and permits another request', async () => {
  const f = fixture(async () => { throw new Error('offline'); });
  await assert.rejects(f.controller.request(), /offline/);
  assert(!f.controller.busy);
  await assert.rejects(f.controller.request(), /offline/);
});
