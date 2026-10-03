import test from 'node:test';
import assert from 'node:assert/strict';
import { runAlertDrill } from '../ops/wiki-interest/alert-drill.mjs';

const healthy = () => ({ phase: 'not_due', issues: [], snapshotSha256: 'a'.repeat(64), generatedAt: '2026-10-03T03:21:00Z', lastSuccessAt: '2026-10-03T03:21:00Z' });
function setup() {
  const calls = [];
  return { calls, options: { observe: async () => healthy(), fail: async () => calls.push('fail'),
    recover: async () => calls.push('recover'), waitImpl: async () => calls.push('wait'),
    delayMs: 0, logger: { log() {} } } };
}
test('manual drill recovers and does not equate API acceptance with recipient delivery', async () => {
  const {calls,options} = setup(); const result = await runAlertDrill(options);
  assert.deepEqual(calls, ['fail','wait','recover']); assert.equal(result.measurementRetained, true);
  assert.equal(result.recipientDeliveryConfirmed, false);
});
test('unhealthy production cannot be deliberately failed or recovered by the drill', async () => {
  const {calls,options} = setup(); options.observe = async () => ({phase:'attention',issues:['collection_not_confirmed']});
  await assert.rejects(runAlertDrill(options)); assert.deepEqual(calls, []);
});
test('failed or uncertain failure request still attempts recovery', async () => {
  const {calls,options} = setup(); options.fail = async () => {calls.push('fail'); throw new Error('Network failure');};
  await assert.rejects(runAlertDrill(options)); assert.deepEqual(calls, ['fail','recover']);
});
test('interrupting the wait recovers immediately without stopping production', async () => {
  const {calls,options} = setup(); options.waitImpl = async () => {throw Object.assign(new Error(), {name:'AbortError'});};
  const result = await runAlertDrill(options); assert.equal(result.waitInterrupted, true); assert.deepEqual(calls,['fail','recover']);
});
test('recovery error and changed measurements cannot be reported as completed', async () => {
  const {options} = setup(); options.recover = async () => {throw new Error('Recovery failed');};
  await assert.rejects(runAlertDrill(options));
  const changed = setup().options; let reads=0; changed.observe = async () => ({...healthy(), snapshotSha256: ++reads === 1 ? 'a'.repeat(64) : 'b'.repeat(64)});
  await assert.rejects(runAlertDrill(changed));
});
test('duration is bounded before any side effect', async () => {
  const {calls,options} = setup(); options.delayMs=180_001; await assert.rejects(runAlertDrill(options)); assert.deepEqual(calls,[]);
});
