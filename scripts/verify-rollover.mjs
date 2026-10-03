import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDate, shiftDate } from '../data-lib.mjs';
import { validateDailySnapshot } from '../runtime-lib.mjs';
import { deriveLiveState, STATUS_MAX_FUTURE_SKEW_MS, validateStatus } from '../src/live-state.js';
import { validateArchive } from '../src/archive-state.js';
import { validateTracks } from '../src/tracking-lib.js';

// A read-only observation, not a collector, timer, alert or publication gate.
// Seeing a new day once does not prove that later checks preserve its bytes.
export function inspectRollover({ snapshot, status, archive = null, tracks = null,
  afterDate, snapshotSha256, now = new Date() }) {
  parseDate(afterDate);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !/^[a-f0-9]{64}$/.test(snapshotSha256)) throw new Error('Invalid observation');
  const completedDate = shiftDate(now.toISOString().slice(0, 10), -1);
  validateDailySnapshot(snapshot, completedDate);
  validateStatus(status);
  if (archive) validateArchive(archive);
  if (tracks) validateTracks(tracks);
  const issues = [];
  if (snapshot.dataDate < afterDate) issues.push('measurement_regressed');
  if (snapshot.collectionOrigin === 'retrospective' && snapshot.dataDate > afterDate) issues.push('new_day_is_retrospective');
  if (status.targetDate < snapshot.dataDate || status.targetDate > completedDate) issues.push('invalid_runner_target');
  if (status.coverage.candidateCount !== snapshot.coverage.candidateCount
    || status.coverage.failuresCount !== snapshot.coverage.failures.length) issues.push('inconsistent_status_coverage');
  for (const product of [snapshot, archive, tracks].filter(Boolean)) {
    if (Date.parse(product.generatedAt) > now.getTime() + STATUS_MAX_FUTURE_SKEW_MS) issues.push('future_publication');
  }
  const live = deriveLiveState(snapshot, status, now.getTime());
  if (!live.automated || live.staleData || ['error', 'stale'].includes(status.state)) issues.push('collection_not_confirmed');
  if (archive?.latestDate > snapshot.dataDate || tracks?.dataDate > snapshot.dataDate) issues.push('product_ahead_of_measurement');
  const archiveAligned = Boolean(archive && archive.latestDate === snapshot.dataDate
    && archive.latestGeneratedAt === snapshot.generatedAt && archive.availableDates.includes(afterDate));
  const trackingAligned = Boolean(tracks && tracks.dataDate === snapshot.dataDate);
  const cohort = tracks?.items ?? [];
  const observedToday = trackingAligned ? cohort.filter(item => item.series.at(-1)?.date === snapshot.dataDate).length : 0;
  const followed = trackingAligned ? cohort.filter(item => item.sampleDates.at(-1) < snapshot.dataDate) : [];
  const followedMeasured = followed.filter(item => item.series.at(-1)?.date === snapshot.dataDate);
  const advanced = snapshot.dataDate > afterDate;
  let phase;
  if (issues.length) phase = 'attention';
  else if (!advanced) phase = completedDate <= afterDate ? 'not_due' : 'waiting_for_new_day';
  else if (!archiveAligned) phase = 'archive_catching_up';
  else if (!trackingAligned || (followed.length && !followedMeasured.length)) phase = 'tracking_catching_up';
  else phase = 'new_day_observed';
  return {
    schemaVersion: 1, observedAt: now.toISOString(), afterDate, firstNewDate: shiftDate(afterDate, 1),
    completedDate, dataDate: snapshot.dataDate, generatedAt: snapshot.generatedAt,
    collectorCheckedAt: status.checkedAt, lastSuccessAt: status.lastSuccessAt,
    snapshotSha256, phase, issues: [...new Set(issues)], advanced,
    archiveAligned, archiveDates: archive?.availableDates ?? [], trackingAligned,
    tracking: { candidates: cohort.length, observedToday, unknownToday: cohort.length - observedToday,
      followed: followed.length, followedMeasured: followedMeasured.length,
      examples: followedMeasured.slice(0, 3).map(item => ({ title: item.title, lastSampleDate: item.sampleDates.at(-1),
        date: item.series.at(-1).date, views: item.series.at(-1).views })) },
    // An empty followed cohort is valid, but cannot demonstrate this feature.
    readyForRepeatCheck: phase === 'new_day_observed' && followedMeasured.length > 0,
  };
}

export function compareObservations(previous, current) {
  const valid = value => value?.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(value.snapshotSha256)
    && Number.isFinite(Date.parse(value.collectorCheckedAt)) && Number.isFinite(Date.parse(value.lastSuccessAt))
    && Number.isFinite(Date.parse(value.generatedAt)) && Array.isArray(value.archiveDates)
    && typeof value.readyForRepeatCheck === 'boolean'
    && (!value.readyForRepeatCheck || (value.phase === 'new_day_observed' && value.advanced === true && value.issues?.length === 0))
    && (() => { try { parseDate(value.dataDate); parseDate(value.afterDate); value.archiveDates.forEach(parseDate); return true; } catch { return false; } })();
  if (!valid(previous) || !valid(current) || previous.afterDate !== current.afterDate) throw new Error('Invalid paired observations');
  if (current.dataDate < previous.dataDate || Date.parse(current.collectorCheckedAt) < Date.parse(previous.collectorCheckedAt)) return { phase: 'regression', stableRepeat: false };
  const available = new Set(current.archiveDates);
  const archiveRetained = previous.archiveDates.every(date => available.has(date));
  if (!archiveRetained) return { phase: 'archive_lost_dates', stableRepeat: false };
  if (current.dataDate !== previous.dataDate) return { phase: 'different_days', stableRepeat: false };
  if (current.collectorCheckedAt === previous.collectorCheckedAt) return { phase: 'same_collector_check', stableRepeat: false };
  const stable = current.snapshotSha256 === previous.snapshotSha256
    && current.lastSuccessAt === previous.lastSuccessAt && current.generatedAt === previous.generatedAt;
  return { phase: !stable ? 'same_day_measurement_changed'
    : current.readyForRepeatCheck && previous.readyForRepeatCheck ? 'verified_repeat' : 'measurement_repeat_only',
    stableRepeat: stable && archiveRetained && current.readyForRepeatCheck && previous.readyForRepeatCheck };
}

export async function readObservation({ runtimeDir, afterDate, now = new Date() }) {
  parseDate(afterDate);
  if (!isAbsolute(runtimeDir) || resolve(runtimeDir) === '/') throw new Error('Choose the existing dedicated runtime');
  const root = join(runtimeDir, 'public');
  const read = name => readFile(join(root, name), 'utf8');
  const optional = async name => { try { return JSON.parse(await read(name)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const before = JSON.parse(await read('status.json'));
  const [bytes, archive, tracks] = await Promise.all([read('snapshot.json'), optional('archive.json'), optional('tracks.json')]);
  const after = JSON.parse(await read('status.json'));
  if (before.checkedAt !== after.checkedAt || before.dataDate !== after.dataDate || before.lastSuccessAt !== after.lastSuccessAt) {
    return { schemaVersion: 1, phase: 'publication_in_progress', observedAt: now.toISOString(), afterDate };
  }
  return inspectRollover({ snapshot: JSON.parse(bytes), status: after, archive, tracks, afterDate, now,
    snapshotSha256: createHash('sha256').update(bytes).digest('hex') });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeFlag, runtimeDir, afterFlag, afterDate, ...extra] = process.argv.slice(2);
  if (runtimeFlag !== '--runtime' || afterFlag !== '--after' || !runtimeDir || !afterDate || extra.length) {
    console.error('Usage: verify-rollover.mjs --runtime ABS_PATH --after YYYY-MM-DD');
    process.exitCode = 1;
  } else {
    readObservation({ runtimeDir, afterDate }).then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (result.phase === 'attention') process.exitCode = 2;
    }).catch(() => { console.error('Rollover observation unavailable or invalid; no files were changed.'); process.exitCode = 2; });
  }
}
