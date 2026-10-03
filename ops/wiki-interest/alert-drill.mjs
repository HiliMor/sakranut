import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { healthcheckEndpoint } from '../../runtime-lib.mjs';
import { readObservation } from '../../scripts/verify-rollover.mjs';

const execute = promisify(execFile);

// Explicit, manual notification drill. Never install in a service/timer. The
// simulated failure is labelled as a drill; production data/status stay healthy.
export async function runAlertDrill({ observe, fail, recover, waitImpl = wait,
  delayMs = 180_000, signal, logger = console }) {
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 180_000) throw new Error('Invalid drill duration');
  const before = await observe();
  if (before.issues?.length || !['not_due', 'waiting_for_new_day', 'new_day_observed'].includes(before.phase)) throw new Error('Production health must be confirmed first');
  const startedAt = new Date().toISOString();
  let failureAccepted = false, waitInterrupted = false;
  try {
    await fail();
    failureAccepted = true;
    logger.log('Planned alert drill: failure accepted; production remains running. Recovery follows in three minutes.');
    try { await waitImpl(delayMs, undefined, { signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; waitInterrupted = true; }
  } finally {
    // Even a rejected/uncertain request or an interrupted wait must not leave
    // the external check in a deliberately failed state.
    await recover();
  }
  const after = await observe();
  const measurementRetained = before.snapshotSha256 === after.snapshotSha256
    && before.generatedAt === after.generatedAt && before.lastSuccessAt === after.lastSuccessAt;
  if (after.issues?.length || !measurementRetained) throw new Error('Drill recovery needs operator review');
  return { schemaVersion: 1, startedAt, recoveredAt: new Date().toISOString(),
    failureAccepted, recoveryConfirmed: true, measurementRetained, waitInterrupted,
    recipientDeliveryConfirmed: false };
}

async function main() {
  if (process.argv.slice(2).join(' ') !== '--run' || process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Use root on Linux with explicit --run');
  const timers = (await execute('systemctl', ['is-active', 'wiki-interest-collect.timer', 'wiki-interest-health.timer'])).stdout.trim().split('\n');
  if (timers.length !== 2 || timers.some(value => value !== 'active')) throw new Error('Both timers must already be active');
  const config = await readFile('/etc/wiki-interest/healthchecks.env', 'utf8');
  const line = config.split('\n').find(value => value.startsWith('WIKI_INTEREST_HEALTHCHECK_URL='));
  const raw = line?.slice('WIKI_INTEREST_HEALTHCHECK_URL='.length).trim();
  const endpoint = healthcheckEndpoint(raw?.replace(/^(["'])(.*)\1$/, '$2'));
  if (!endpoint) throw new Error('Dedicated monitoring must already be configured');
  const current = JSON.parse(await readFile('/var/lib/wiki-interest/public/snapshot.json', 'utf8'));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('SIGHUP', stop);
  try {
    const result = await runAlertDrill({ signal: abort.signal,
      observe: () => readObservation({ runtimeDir: '/var/lib/wiki-interest', afterDate: current.dataDate }),
      fail: async () => {
        const response = await fetch(`${endpoint}/fail`, { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'text/plain' },
          body: 'PLANNED SAKRANUT ALERT DRILL: production collection and website remain healthy. Recovery is scheduled in three minutes.',
          signal: AbortSignal.timeout(10_000) });
        if (!response.ok || (await response.text()).trim() !== 'OK') throw new Error('Drill signal not accepted');
      },
      recover: async () => {
        await execute('systemctl', ['start', 'wiki-interest-health.service'], { timeout: 30_000 });
        const state = (await execute('systemctl', ['show', 'wiki-interest-health.service', '-p', 'Result', '-p', 'ExecMainStatus'])).stdout;
        if (!state.includes('Result=success\n') || !state.includes('ExecMainStatus=0\n')) throw new Error('Recovery service failed');
      },
    });
    console.log(JSON.stringify(result));
  } finally { for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(event, stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Alert drill incomplete; inspect dedicated health check and recovery service. No secret endpoint is printed.'); process.exitCode = 1; });
}
