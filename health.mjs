import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { shiftDate } from './data-lib.mjs';
import { atomicJson, DEFAULT_RUNTIME_DIR, healthcheckEndpoint, makeStatus, readJson, runtimePaths, validateDailySnapshot, withRuntimeLock } from './runtime-lib.mjs';

export async function checkHealth({ runtimeDir = process.env.WIKI_INTEREST_RUNTIME_DIR || DEFAULT_RUNTIME_DIR, healthcheckUrl = process.env.WIKI_INTEREST_HEALTHCHECK_URL, now = () => new Date(), fetchImpl = fetch, lock = withRuntimeLock, logger = console } = {}) {
  return lock(runtimeDir, async () => {
    const paths = runtimePaths(runtimeDir), checkedNow = now();
    const endpoint = healthcheckEndpoint(healthcheckUrl);
    let snapshot = null, runnerState = null;
    try {
      snapshot = await readJson(paths.snapshot);
      if (snapshot) validateDailySnapshot(snapshot, shiftDate(checkedNow.toISOString().slice(0, 10), -1));
    } catch { snapshot = null; }
    try { runnerState = await readJson(paths.state); }
    catch { runnerState = { invalid: true }; }
    const status = makeStatus({ snapshot, runnerState, now: checkedNow, healthCheckedAt: checkedNow.toISOString(), monitoringConfigured: Boolean(endpoint) });
    await atomicJson(paths.status, status);
    const unhealthy = ['error', 'stale'].includes(status.state);
    let exitCode = unhealthy ? 2 : 0;
    if (endpoint) {
      try {
        const response = await fetchImpl(`${endpoint}${unhealthy ? '/fail' : ''}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `wiki-interest: ${status.state}; data ${status.dataDate ?? 'unavailable'}`, signal: AbortSignal.timeout(10_000), redirect: 'error' });
        await response.body?.cancel();
        if (!response.ok) throw new Error('Ping failed');
      } catch {
        logger.error('Dedicated external health notification failed.');
        exitCode ||= 1;
      }
    }
    logger.log(`Health: ${status.state}; external monitoring ${endpoint ? 'configured' : 'not configured'}.`);
    return { status, exitCode };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error('Usage: node health.mjs (configuration via WIKI_INTEREST_* environment).'); process.exitCode = 1; }
  else checkHealth().then(result => { process.exitCode = result.exitCode; }).catch(error => { console.error(error.code === 'LOCK_BUSY' ? 'Another wiki-interest operation is running.' : error.code === 'LOCK_UNSUPPORTED' ? error.message : 'Health check failed; inspect permissions/configuration.'); process.exitCode = 1; });
}
