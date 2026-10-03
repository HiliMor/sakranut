import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDate, shiftDate } from './data-lib.mjs';
import { validateSnapshot } from './src/ui-lib.js';

export const DEFAULT_RUNTIME_DIR = '/var/lib/wiki-interest';
export const MAX_CHECK_AGE_MS = 6 * 60 * 60 * 1000;

export function runtimePaths(runtimeDir) {
  return {
    snapshot: join(runtimeDir, 'public/snapshot.json'), status: join(runtimeDir, 'public/status.json'),
    state: join(runtimeDir, 'runner-state.json'), history: join(runtimeDir, 'history'),
    archive: join(runtimeDir, 'public/archive'), archiveIndex: join(runtimeDir, 'public/archive.json'),
    descriptions: join(runtimeDir, 'public/descriptions.json'), descriptionCache: join(runtimeDir, 'description-cache.json'),
  };
}

// Unique temporary names and same-directory rename avoid partial JSON reads and
// concurrent .tmp collisions. The last-good destination survives write errors.
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporaryPath, 'wx', 0o644);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporaryPath, path);
  } finally {
    await file?.close();
    await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Linux's kernel lock is released on process death; there is no stale PID file
// to delete and no race-prone check-then-unlink recovery. The helper owns the lock
// until the parent's pipe closes, including when the parent crashes.
export async function withRuntimeLock(runtimeDir, work) {
  if (process.platform !== 'linux') throw Object.assign(new Error('Scheduled runtime requires Linux util-linux flock.'), { code: 'LOCK_UNSUPPORTED' });
  await mkdir(runtimeDir, { recursive: true });
  const helper = "process.stdout.write('locked\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";
  const child = spawn('flock', ['--exclusive', '--nonblock', join(runtimeDir, 'runtime.lock'), process.execPath, '-e', helper], { stdio: ['pipe', 'pipe', 'ignore'] });
  let acquired = false;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('Runtime lock acquisition timed out.'), { code: 'LOCK_ERROR' })), 5_000);
      timer.unref();
      child.once('error', () => { clearTimeout(timer); reject(Object.assign(new Error('Linux util-linux flock is required.'), { code: 'LOCK_ERROR' })); });
      child.once('exit', () => { clearTimeout(timer); if (!acquired) reject(Object.assign(new Error('Another runtime operation is already running.'), { code: 'LOCK_BUSY' })); });
      child.stdout.once('data', data => {
        clearTimeout(timer);
        if (data.toString().trim() !== 'locked') return reject(Object.assign(new Error('Runtime lock protocol error.'), { code: 'LOCK_ERROR' }));
        acquired = true;
        resolve();
      });
    });
    return await work();
  } finally {
    child.stdin.end();
    // A failed spawn has no exit event. A running helper exits when stdin closes.
    if (child.pid) await exited;
  }
}

export function validateDailySnapshot(snapshot, targetDate) {
  validateSnapshot(snapshot);
  if (snapshot.dataDate > targetDate) throw new Error('Snapshot is not a completed UTC day');
  const c = snapshot.coverage;
  if (!c || !Number.isSafeInteger(c.candidateCount) || c.candidateCount < 1 || c.candidateCount > 30 || c.articleCount !== snapshot.articles.length || !Array.isArray(c.failures) || c.articleCount + c.failures.length !== c.candidateCount || c.articleCount < Math.ceil(c.candidateCount * .75)) throw new Error('Invalid or insufficient snapshot coverage');
  return snapshot;
}

export function healthcheckEndpoint(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid dedicated Healthchecks URL configuration.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'hc-ping.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname)) throw new Error('Invalid dedicated Healthchecks URL configuration.');
  return url.href;
}

export function makeStatus({ snapshot, runnerState, now = new Date(), monitoringConfigured = false, healthCheckedAt = null }) {
  const targetDate = shiftDate(now.toISOString().slice(0, 10), -1);
  const dataDate = snapshot?.dataDate ?? null;
  const checkedAt = runnerState?.checkedAt ?? null;
  const lastSuccessAt = runnerState?.lastSuccessAt ?? null;
  const checkAge = checkedAt ? now.getTime() - Date.parse(checkedAt) : Infinity;
  const ageDays = dataDate ? (parseDate(now.toISOString().slice(0, 10)) - parseDate(dataDate)) / 86400000 : Infinity;
  const validTimestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
  const validDate = value => { try { parseDate(value); return true; } catch { return false; } };
  const coherentState = runnerState && runnerState.schemaVersion === 1 && ['healthy', 'waiting', 'error'].includes(runnerState.outcome) &&
    validTimestamp(checkedAt) && validTimestamp(lastSuccessAt) && validDate(runnerState.targetDate) &&
    runnerState.dataDate === dataDate && dataDate <= runnerState.targetDate && runnerState.targetDate <= targetDate &&
    Date.parse(lastSuccessAt) >= Date.parse(snapshot?.generatedAt) && Date.parse(lastSuccessAt) <= Date.parse(checkedAt) &&
    Date.parse(checkedAt) <= now.getTime();
  let state, message;
  if (!snapshot) { state = 'error'; message = 'No validated snapshot has been published yet.'; }
  else if (dataDate > targetDate) { state = 'error'; message = 'Published data does not refer to a completed UTC day.'; }
  else if (runnerState && !coherentState) { state = 'error'; message = 'Runner state is inconsistent with the published snapshot; operator review is required.'; }
  else if (!Number.isFinite(checkAge) || checkAge < 0 || checkAge > MAX_CHECK_AGE_MS) { state = 'stale'; message = 'The daily runner has not completed a check in more than six hours.'; }
  else if (ageDays >= 3) { state = 'stale'; message = 'The newest available data is at least three UTC calendar days old.'; }
  else if (runnerState?.outcome === 'error') { state = 'error'; message = 'The last collection failed; the previous validated snapshot is retained.'; }
  else if (dataDate < targetDate) { state = 'waiting'; message = 'Waiting for a sufficiently complete prior-day partition; the previous validated snapshot is retained.'; }
  else { state = 'healthy'; message = 'The latest completed UTC day is available.'; }
  return {
    schemaVersion: 1, mode: 'scheduled', checkedAt, lastSuccessAt, dataDate, targetDate, state, message,
    coverage: { candidateCount: snapshot?.coverage?.candidateCount ?? 0, articleCount: snapshot?.articles?.length ?? 0, failuresCount: snapshot?.coverage?.failures?.length ?? 0 },
    monitoring: { configured: monitoringConfigured },
    ...(healthCheckedAt ? { healthCheckedAt } : {}),
  };
}

export async function updateHistoryIndex(historyDir, now = new Date()) {
  await mkdir(historyDir, { recursive: true });
  const availableDates = (await readdir(historyDir)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map(name => name.slice(0, 10)).sort();
  const missingDates = [], known = new Set(availableDates);
  if (availableDates.length) {
    for (let day = availableDates[0]; day <= availableDates.at(-1); day = shiftDate(day, 1)) if (!known.has(day)) missingDates.push(day);
  }
  const index = { schemaVersion: 1, checkedAt: now.toISOString(), availableDates, missingDates, backfill: 'Not automatic; missing dates are never synthesized.' };
  await atomicJson(join(historyDir, 'index.json'), index);
  return index;
}
