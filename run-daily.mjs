import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { collectSnapshot } from './collect.mjs';
import { shiftDate } from './data-lib.mjs';
import { atomicJson, DEFAULT_RUNTIME_DIR, healthcheckEndpoint, makeStatus, readJson, runtimePaths, updateHistoryIndex, validateDailySnapshot, withRuntimeLock } from './runtime-lib.mjs';
import { updateReadingProducts } from './reading-products.mjs';

export async function runDaily({ runtimeDir = process.env.WIKI_INTEREST_RUNTIME_DIR || DEFAULT_RUNTIME_DIR, healthcheckUrl = process.env.WIKI_INTEREST_HEALTHCHECK_URL, now = () => new Date(), collect = collectSnapshot, updateProducts = updateReadingProducts, lock = withRuntimeLock, logger = console } = {}) {
  return lock(runtimeDir, async () => {
    const paths = runtimePaths(runtimeDir);
    const targetDate = shiftDate(now().toISOString().slice(0, 10), -1);
    const monitoringConfigured = Boolean(healthcheckEndpoint(healthcheckUrl));
    let snapshot = null, previousState = null;
    try {
      snapshot = await readJson(paths.snapshot);
      if (snapshot) {
        validateDailySnapshot(snapshot, targetDate);
        if (new Date(snapshot.generatedAt) > now()) throw new Error('Future generation time');
      }
    }
    catch { throw new Error('Existing published snapshot is invalid; refusing to overwrite it.'); }
    previousState = await readJson(paths.state);
    let outcome = 'healthy', exitCode = 0, published = false;
    // Re-fetch a legacy same-day snapshot once to populate the additive partial
    // history field. After upgrade, repeated checks remain network-free.
    if (snapshot?.dataDate !== targetDate || !Array.isArray(snapshot?.uncomparedArticles)) {
      try {
        const fresh = await collect({ requestedDate: targetDate, maxFallbackDays: 0, now, logger });
        validateDailySnapshot(fresh, targetDate);
        if (!Array.isArray(fresh.uncomparedArticles)) throw new Error('Collector did not provide the current snapshot format');
        if (fresh.dataDate !== targetDate) throw new Error('Collector returned a different day');
        if (new Date(fresh.generatedAt) > now()) throw new Error('Collector generation time is in the future');
        // Archive before publishing. Imported previous good data is retained too.
        if (snapshot) {
          if (snapshot.dataDate === fresh.dataDate) {
            const revision = snapshot.generatedAt.replaceAll(/[^0-9TZ]/g, '');
            await atomicJson(join(paths.history, 'revisions', `${snapshot.dataDate}-${revision}.json`), snapshot);
          } else await atomicJson(join(paths.history, `${snapshot.dataDate}.json`), snapshot);
        }
        await atomicJson(join(paths.history, `${fresh.dataDate}.json`), fresh);
        await updateHistoryIndex(paths.history, now());
        await atomicJson(paths.snapshot, fresh);
        snapshot = fresh;
        published = true;
      } catch (error) {
        const waiting = error.status === 404 || error.code === 'PARTIAL_DATA';
        outcome = waiting ? 'waiting' : 'error';
        // Delayed upstream partitions are expected; validation/network errors fail
        // the systemd execution and remain visible to the hourly health command.
        exitCode = waiting ? 0 : 1;
        logger.warn(waiting ? 'Prior-day data is not sufficiently available; retaining last-good snapshot.' : 'Collection failed; retaining last-good snapshot.');
      }
    } else {
      await atomicJson(join(paths.history, `${snapshot.dataDate}.json`), snapshot);
      await updateHistoryIndex(paths.history, now());
    }
    const finishedAt = now();
    const runnerState = {
      schemaVersion: 1, checkedAt: finishedAt.toISOString(),
      lastSuccessAt: published ? finishedAt.toISOString() : previousState?.lastSuccessAt ?? snapshot?.generatedAt ?? null,
      dataDate: snapshot?.dataDate ?? null, targetDate, outcome,
    };
    await atomicJson(paths.state, runnerState);
    const status = makeStatus({ snapshot, runnerState, now: finishedAt, monitoringConfigured });
    await atomicJson(paths.status, status);
    // Measurement success is committed first. Optional reading aids cannot turn
    // a valid collection into a failure or advance its last-success timestamp.
    try { await updateProducts({ runtimeDir, snapshot, now: now(), logger }); }
    catch { logger.warn('Optional reading aids unavailable; measurement publication and health retained.'); }
    logger.log(`Daily check: ${status.state}; data ${status.dataDate ?? 'unavailable'}; target ${status.targetDate}; ${published ? 'published' : 'unchanged'}.`);
    return { status, published, exitCode };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error('Usage: node run-daily.mjs (configuration via WIKI_INTEREST_* environment).'); process.exitCode = 1; }
  else runDaily().then(result => { process.exitCode = result.exitCode; }).catch(error => { console.error(error.code === 'LOCK_BUSY' ? 'Another wiki-interest operation is running.' : error.code === 'LOCK_UNSUPPORTED' ? error.message : 'Daily runner failed; inspect permissions/configuration. Existing files were not removed.'); process.exitCode = 1; });
}
