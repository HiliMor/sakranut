import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDate, shiftDate } from '../data-lib.mjs';
import { buildResearchQueue, validateDrafts, validateResearchQueue } from '../src/context-pilot-lib.js';
import { runContextPilot } from './context-pilot.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LIMIT = 7;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, dataDate) => { throw Object.assign(new Error(code), { pilotCode: code, dataDate }); };
const result = (status, extra = {}) => ({ status, reviewStatus: 'draft', published: false, ...extra });
const validTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const onlyKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));

async function fixedPath(projectRoot, ...parts) {
  let path = resolve(projectRoot);
  for (const part of ['data', 'context-pilot', ...parts]) {
    path = join(path, part);
    try { if ((await lstat(path)).isSymbolicLink()) fail('unsafe_path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path;
}

async function readRecord(path, { optional = false } = {}) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) fail('invalid_file');
    const bytes = await file.readFile();
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('invalid_json'); }
    return { value, sha256: hash(bytes) };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') fail('unsafe_path');
    throw error;
  } finally { await file?.close(); }
}

async function createRecord(path, value, mode = 0o600) {
  const file = await open(path, 'wx', mode);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
}

function countsFor(queue, drafts, dataDate, completedAt) {
  try { validateDrafts(drafts, queue); } catch { fail('invalid_drafts', dataDate); }
  if (drafts.items.some(item => item.sources.some(source => source.sourceReadAt !== null
    && Date.parse(source.sourceReadAt) > Date.parse(completedAt)))) fail('invalid_draft_chronology', dataDate);
  // validateDrafts already enforces exact titles, uniqueness, queue identity and
  // draft status; equal cardinality therefore establishes complete coverage.
  if (drafts.items.length !== queue.items.length) fail('incomplete_coverage', dataDate);
  return {
    queued: queue.items.length,
    candidate: drafts.items.filter(item => item.verdict === 'candidate').length,
    abstain: drafts.items.filter(item => item.verdict === 'abstain').length,
  };
}

function validatePreparation(record, day, now) {
  const value = record.value;
  if (!onlyKeys(value, ['schemaVersion', 'kind', 'dataDate', 'queueId', 'queueSha256', 'preparedAt', 'preparedUtcDate', 'reviewStatus', 'published'])
    || value.schemaVersion !== 1 || value.kind !== 'context_daily_preparation' || value.dataDate !== day.dataDate
    || value.queueId !== day.queue.value.queueId || value.queueSha256 !== day.queue.sha256
    || !validTimestamp(value.preparedAt) || Date.parse(value.preparedAt) > now.getTime()
    || Date.parse(value.preparedAt) < Date.parse(day.queue.value.snapshotGeneratedAt)
    || value.preparedUtcDate !== value.preparedAt.slice(0, 10)
    || shiftDate(value.preparedUtcDate, -1) !== day.dataDate
    || value.reviewStatus !== 'draft' || value.published !== false) fail('invalid_preparation', day.dataDate);
}

function validateCompletion(record, day, now) {
  const value = record.value;
  if (!day.drafts) fail('completed_artifacts_changed', day.dataDate);
  if (!onlyKeys(value, ['schemaVersion', 'kind', 'dataDate', 'queueId', 'queueSha256', 'draftsSha256', 'completedAt', 'counts', 'researchStatus', 'reviewStatus', 'published'])
    || value.schemaVersion !== 1 || value.kind !== 'context_daily_completion' || value.dataDate !== day.dataDate
    || value.queueId !== day.queue.value.queueId || value.queueSha256 !== day.queue.sha256 || value.draftsSha256 !== day.drafts.sha256
    || value.researchStatus !== 'completed' || value.reviewStatus !== 'draft' || value.published !== false
    || !validTimestamp(value.completedAt) || Date.parse(value.completedAt) > now.getTime()
    || Date.parse(value.completedAt) < Date.parse(day.queue.value.snapshotGeneratedAt)
    || (day.preparation && Date.parse(value.completedAt) < Date.parse(day.preparation.value.preparedAt))) fail('completed_artifacts_changed', day.dataDate);
  const counts = countsFor(day.queue.value, day.drafts.value, day.dataDate, value.completedAt);
  if (!onlyKeys(value.counts, ['queued', 'candidate', 'abstain'])
    || Object.keys(counts).some(key => value.counts[key] !== counts[key])) fail('invalid_completion', day.dataDate);
}

async function inspectDays(projectRoot, now) {
  const root = await fixedPath(projectRoot);
  const days = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    try { parseDate(entry.name); } catch { fail('invalid_day_directory'); }
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('unsafe_path', entry.name);
    const day = { dataDate: entry.name };
    for (const name of ['queue', 'drafts', 'preparation', 'completion']) {
      day[name] = await readRecord(await fixedPath(projectRoot, entry.name, `${name}.json`), { optional: true });
    }
    if (!day.queue && !day.drafts && !day.preparation && !day.completion) continue;
    if (!day.queue) fail('missing_queue', day.dataDate);
    try { validateResearchQueue(day.queue.value); } catch { fail('invalid_queue', day.dataDate); }
    if (day.queue.value.dataDate !== day.dataDate || Date.parse(day.queue.value.snapshotGeneratedAt) > now.getTime()) fail('invalid_queue', day.dataDate);
    if (day.preparation) validatePreparation(day.preparation, day, now);
    if (day.completion) validateCompletion(day.completion, day, now);
    else if (day.drafts) {
      try { validateDrafts(day.drafts.value, day.queue.value); } catch { fail('invalid_drafts', day.dataDate); }
    }
    days.push(day);
  }
  return days;
}

async function prepare(snapshotPath, projectRoot, now, days) {
  let queue;
  try { queue = buildResearchQueue((await readRecord(resolve(snapshotPath))).value); }
  catch (error) { if (error.pilotCode) throw error; fail('invalid_snapshot'); }
  const today = now.toISOString().slice(0, 10), targetDate = shiftDate(today, -1);
  const completedDays = days.filter(day => day.completion).length;
  if (queue.dataDate !== targetDate || Date.parse(queue.snapshotGeneratedAt) > now.getTime()) {
    return result('blocked', { code: 'snapshot_not_previous_utc_day', dataDate: queue.dataDate, targetDate, completedDays });
  }
  const existing = days.find(day => day.dataDate === targetDate);
  if (existing?.completion) return result('already_completed', { dataDate: targetDate, completedDays });
  if (completedDays >= LIMIT) return result('pilot_complete', { completedDays });
  if (existing && existing.queue.value.queueId !== queue.queueId) return result('blocked', { code: 'conflicting_queue', dataDate: targetDate, completedDays });
  const pending = days.find(day => !day.completion);
  if (pending) return result('awaiting_completion', { code: pending.drafts ? 'drafts_in_progress' : 'queue_in_progress', dataDate: pending.dataDate, completedDays });
  if (days.some(day => day.preparation?.value.preparedUtcDate === today)) return result('blocked', { code: 'daily_preparation_limit', dataDate: targetDate, completedDays });
  const prepared = await runContextPilot(['queue', '--snapshot', resolve(snapshotPath)], { projectRoot, log: () => {} });
  if (prepared.queue.queueId !== queue.queueId) fail('snapshot_changed_during_preparation', targetDate);
  const written = await readRecord(await fixedPath(projectRoot, targetDate, 'queue.json'));
  const marker = {
    schemaVersion: 1, kind: 'context_daily_preparation', dataDate: targetDate,
    queueId: queue.queueId, queueSha256: written.sha256,
    preparedAt: now.toISOString(), preparedUtcDate: today, reviewStatus: 'draft', published: false,
  };
  await createRecord(await fixedPath(projectRoot, targetDate, 'preparation.json'), marker);
  return result('ready_to_research', { dataDate: targetDate, queueId: queue.queueId, queuePath: prepared.path, queued: queue.items.length, completedDays });
}

async function complete(dataDate, projectRoot, now, days) {
  const completedDays = days.filter(day => day.completion).length;
  const day = days.find(value => value.dataDate === dataDate);
  if (day?.completion) return result('already_completed', { dataDate, completedDays, counts: day.completion.value.counts });
  if (completedDays >= LIMIT) return result('pilot_complete', { completedDays });
  if (!day) return result('blocked', { code: 'missing_queue', dataDate, completedDays });
  if (!day.drafts) return result('awaiting_completion', { code: 'missing_drafts', dataDate, completedDays });
  const counts = countsFor(day.queue.value, day.drafts.value, dataDate, now.toISOString());
  const receipt = {
    schemaVersion: 1, kind: 'context_daily_completion', dataDate,
    queueId: day.queue.value.queueId, queueSha256: day.queue.sha256, draftsSha256: day.drafts.sha256,
    completedAt: now.toISOString(), counts, researchStatus: 'completed', reviewStatus: 'draft', published: false,
  };
  // Detect concurrent edits made outside this guard before sealing the record.
  for (const name of ['queue', 'drafts']) {
    const current = await readRecord(await fixedPath(projectRoot, dataDate, `${name}.json`));
    if (current.sha256 !== day[name].sha256) fail('artifacts_changed_during_completion', dataDate);
  }
  await createRecord(await fixedPath(projectRoot, dataDate, 'completion.json'), receipt, 0o400);
  return result(completedDays + 1 === LIMIT ? 'pilot_complete' : 'completed', { dataDate, completedDays: completedDays + 1, counts });
}

/** No clock/output override exists in the CLI. Dependency injection is for tests. */
export async function runContextDaily(args, { projectRoot = PROJECT_ROOT, now = () => new Date() } = {}) {
  let lock, lockPath;
  try {
    if (args.length !== 3 || !['prepare', 'complete'].includes(args[0])
      || (args[0] === 'prepare' ? args[1] !== '--snapshot' : args[1] !== '--date') || !args[2]) fail('invalid_arguments');
    if (args[0] === 'complete') { try { parseDate(args[2]); } catch { fail('invalid_date'); } }
    const instant = now();
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) fail('invalid_clock');
    const root = await fixedPath(projectRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await fixedPath(projectRoot);
    lockPath = await fixedPath(projectRoot, 'daily.lock');
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('busy_or_interrupted_run'); throw error; }
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: instant.toISOString() }));
    const days = await inspectDays(projectRoot, instant);
    return args[0] === 'prepare' ? await prepare(args[2], projectRoot, instant, days) : await complete(args[2], projectRoot, instant, days);
  } catch (error) {
    return result('blocked', { code: error.pilotCode || (error.code === 'ENOENT' ? 'missing_file' : 'file_operation_failed'), ...(error.dataDate ? { dataDate: error.dataDate } : {}) });
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = await runContextDaily(process.argv.slice(2));
  console.log(JSON.stringify(outcome));
  if (outcome.status === 'blocked') process.exitCode = 2;
}
