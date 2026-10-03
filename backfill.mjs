import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';
import { collectSnapshot, fetchJson } from './collect.mjs';
import { articleRangeUrl, parseDate, selectCandidates, shiftDate, topUrl, windowFor } from './data-lib.mjs';
import { archiveProjection, publishArchive } from './archive-products.mjs';
import { atomicJson, readJson, runtimePaths, updateHistoryIndex, validateDailySnapshot, withRuntimeLock } from './runtime-lib.mjs';
import { mergeObservations, parseRange, seedTracking, validateTrackingCache } from './tracking-products.mjs';

const quiet = { log() {}, warn() {} };
const pathsFor = stageDir => {
  if (!isAbsolute(stageDir) || resolve(stageDir) === '/' || resolve(stageDir).split('/').length < 3) throw new Error('Use a dedicated absolute staging directory');
  return { history: join(stageDir, 'prepared-history'), seeds: join(stageDir, 'seed-history'),
    cache: join(stageDir, 'backfill-series.json'), report: join(stageDir, 'backfill-report.json') };
};
const apiItems = (series, date) => series.filter(point => point.date >= windowFor(date).seriesStart && point.date <= date)
  .map(point => ({ timestamp: `${point.date.replaceAll('-', '')}00`, views: point.views }));

// Network work is isolated from the scheduled runtime. Each day's sample is its
// own top list; overlapping series are reused, never today's titles projected back.
export async function prepareBackfill({ stageDir, endDate, days, now = () => new Date(), fetchImpl = fetch, waitImpl, logger = console }) {
  const paths = pathsFor(stageDir);
  parseDate(endDate);
  if (!Number.isInteger(days) || days < 1 || days > 30 || endDate >= now().toISOString().slice(0, 10)) throw new Error('Choose 1–30 completed UTC days');
  const startDate = shiftDate(endDate, -(days - 1));
  const dates = Array.from({ length: days }, (_, i) => shiftDate(startDate, i));
  const existing = new Map(), topLists = new Map(), membership = new Map();
  const failures = [];
  let requests = 0;
  const request = url => fetchJson(url, { fetchImpl: async (...args) => { requests += 1; return fetchImpl(...args); }, waitImpl });
  for (const date of dates) {
    for (const dir of [paths.history, paths.seeds]) {
      const value = await readJson(join(dir, `${date}.json`));
      if (!value) continue;
      validateDailySnapshot(value, endDate);
      if (value.dataDate !== date || Date.parse(value.generatedAt) > now().getTime()) throw new Error('Invalid staging measurement');
      existing.set(date, value); break;
    }
    if (existing.has(date)) continue;
    let response = await readJson(join(stageDir, 'top-lists', `${date}.json`));
    if (!response) {
      try { response = await request(topUrl(date)); }
      catch (error) {
        if (error.code === 'STOP_COLLECTION' || error.status === 403) throw error;
        failures.push({ date, reason: error.status === 404 ? 'Top list unavailable' : 'Top list request failed' });
        continue;
      }
    }
    const day = response.items?.[0];
    if (`${day?.year}-${day?.month}-${day?.day}` !== date || !Array.isArray(day.articles) || !selectCandidates(day.articles).length) throw new Error('Invalid historical top list');
    await atomicJson(join(stageDir, 'top-lists', `${date}.json`), response);
    topLists.set(date, response);
    for (const candidate of selectCandidates(day.articles)) {
      const title = candidate.article.replaceAll('_', ' '), known = membership.get(title) ?? [];
      known.push(date); membership.set(title, known);
    }
  }
  let cache = await readJson(paths.cache) ?? { schemaVersion: 1, items: [] };
  validateTrackingCache(cache);
  if (cache.retryAt && Date.parse(cache.retryAt) > now().getTime()) throw Object.assign(new Error('Publisher-requested backoff remains active'), { code: 'STOP_COLLECTION' });
  const seeded = seedTracking(cache, [...existing.values()]);
  const entries = seeded.entries;
  for (const [title, sampled] of seeded.membership) {
    membership.set(title, [...new Set([...(membership.get(title) ?? []), ...sampled])].sort());
  }
  for (const [title, sampled] of membership) {
    const requiredFrom = windowFor(sampled[0]).seriesStart;
    let old = entries.get(title);
    const ranges = !old ? [[requiredFrom, endDate]] : [
      ...(old.checkedFrom > requiredFrom ? [[requiredFrom, shiftDate(old.checkedFrom, -1)]] : []),
      ...(old.checkedThrough < endDate ? [[shiftDate(old.checkedThrough, 1), endDate]] : []),
    ];
    for (const [from, through] of ranges) {
      try {
        const response = await request(articleRangeUrl(title, from, through));
        const incoming = parseRange(response.items, from, through);
        old = { title, series: mergeObservations(old?.series, incoming),
          checkedFrom: old && old.checkedFrom < from ? old.checkedFrom : from,
          checkedThrough: old && old.checkedThrough > through ? old.checkedThrough : through, fetchedAt: now().toISOString() };
        entries.set(title, old);
        // Resumable checkpoint after each successful range, not only at the end.
        await atomicJson(paths.cache, validateTrackingCache({ schemaVersion: 1, items: [...entries.values()] }));
      } catch (error) {
        if (error.code === 'STOP_COLLECTION' || error.status === 403) {
          await atomicJson(paths.cache, { schemaVersion: 1, items: [...entries.values()],
            retryAt: error.retryAt ?? new Date(now().getTime() + 3 * 3600_000).toISOString() });
          throw error;
        }
        logger.warn('Backfill: one series unavailable; no observations were invented.');
      }
    }
  }
  const prepared = [];
  for (const date of dates) {
    if (existing.has(date)) { prepared.push(date); continue; }
    if (!topLists.has(date)) continue;
    try {
      const snapshot = await collectSnapshot({ requestedDate: date, maxFallbackDays: 0, now, logger: quiet,
        fetchTop: async () => topLists.get(date),
        fetchSeries: async title => ({ items: apiItems(entries.get(title.replaceAll('_', ' '))?.series ?? [], date) }) });
      snapshot.collectionOrigin = 'retrospective';
      await atomicJson(join(paths.history, `${date}.json`), archiveProjection(snapshot));
      prepared.push(date);
      logger.log(`Backfill: ${date}; ${snapshot.articles.length}/${snapshot.coverage.candidateCount} complete histories.`);
    } catch (error) {
      failures.push({ date, reason: error.code === 'PARTIAL_DATA' ? 'Insufficient complete histories' : 'Invalid historical measurement' });
    }
  }
  // Seed editions are copied as validated projections, with their real original
  // timestamps/origin. Import never overwrites an already saved runtime edition.
  for (const [date, snapshot] of existing) await atomicJson(join(paths.history, `${date}.json`), archiveProjection(snapshot));
  const report = { schemaVersion: 1, generatedAt: now().toISOString(), startDate, endDate, requestedDays: days,
    preparedDates: prepared, failures, requests, uniqueTitles: membership.size };
  await atomicJson(paths.report, report);
  return report;
}

// Only import after a reviewed preparation report. No network requests under
// this lock, no snapshot/status/runner writes, and no replacement of saved days.
export async function importBackfill({ runtimeDir, stageDir, now = new Date(), lock = withRuntimeLock, logger = console }) {
  const stage = pathsFor(stageDir), report = await readJson(stage.report);
  if (report?.schemaVersion !== 1 || !Number.isInteger(report.requestedDays) || report.requestedDays < 1 || report.requestedDays > 30
    || !Array.isArray(report.preparedDates) || report.preparedDates.length > report.requestedDays) throw new Error('Invalid preparation report');
  parseDate(report.startDate); parseDate(report.endDate);
  if (report.endDate !== shiftDate(report.startDate, report.requestedDays - 1)
    || new Set(report.preparedDates).size !== report.preparedDates.length) throw new Error('Invalid preparation window');
  const prepared = [];
  for (const date of report.preparedDates) {
    parseDate(date);
    if (date < report.startDate || date > report.endDate) throw new Error('Edition outside preparation window');
    const snapshot = validateDailySnapshot(await readJson(join(stage.history, `${date}.json`)), report.endDate);
    if (snapshot.dataDate !== date || Date.parse(snapshot.generatedAt) > now.getTime()) throw new Error('Invalid prepared edition');
    prepared.push(archiveProjection(snapshot));
  }
  const incomingCache = validateTrackingCache(await readJson(stage.cache) ?? { schemaVersion: 1, items: [] });
  if (incomingCache.items.some(item => item.checkedThrough > report.endDate || Date.parse(item.fetchedAt) > now.getTime())) throw new Error('Future preparation observations');
  return lock(runtimeDir, async () => {
    const paths = runtimePaths(runtimeDir), current = validateDailySnapshot(await readJson(paths.snapshot), shiftDate(now.toISOString().slice(0, 10), -1));
    if (report.endDate > current.dataDate) throw new Error('Preparation is ahead of the live measurement');
    const additions = [];
    let added = 0, retained = 0;
    for (const snapshot of prepared) {
      const destination = join(paths.history, `${snapshot.dataDate}.json`);
      if (await readJson(destination)) { retained += 1; continue; }
      if (snapshot.collectionOrigin !== 'retrospective') throw new Error('A new backfilled day must disclose retrospective collection');
      additions.push([destination, snapshot]);
    }
    let prior = await readJson(paths.trackingCache) ?? { schemaVersion: 1, items: [] };
    validateTrackingCache(prior);
    const entries = new Map(incomingCache.items.map(item => [item.title, item]));
    for (const item of prior.items) {
      const incoming = entries.get(item.title);
      entries.set(item.title, incoming ? { ...item, series: mergeObservations(incoming.series, item.series),
        checkedFrom: incoming.checkedFrom < item.checkedFrom ? incoming.checkedFrom : item.checkedFrom,
        checkedThrough: incoming.checkedThrough > item.checkedThrough ? incoming.checkedThrough : item.checkedThrough,
        fetchedAt: incoming.fetchedAt > item.fetchedAt ? incoming.fetchedAt : item.fetchedAt } : item);
    }
    const combined = validateTrackingCache({ schemaVersion: 1, items: [...entries.values()], ...(prior.retryAt ? { retryAt: prior.retryAt } : {}) });
    for (const [destination, snapshot] of additions) { await atomicJson(destination, snapshot); added += 1; }
    await atomicJson(paths.trackingCache, combined);
    await updateHistoryIndex(paths.history, now);
    await publishArchive({ runtimeDir, snapshot: current, now, logger, force: true });
    logger.log(`Backfill import: ${added} added; ${retained} existing editions retained.`);
    return { added, retained };
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (args.length % 2 || new Set(args.filter((_, i) => i % 2 === 0)).size !== args.length / 2) throw new Error('Invalid arguments');
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[2 * i], args[2 * i + 1]]));
  if (command === 'prepare' && Object.keys(options).sort().join() === '--days,--end,--stage') {
    const result = await prepareBackfill({ stageDir: options['--stage'], endDate: options['--end'], days: Number(options['--days']) });
    console.log(JSON.stringify(result));
  } else if (command === 'import' && Object.keys(options).sort().join() === '--runtime,--stage') {
    await importBackfill({ stageDir: options['--stage'], runtimeDir: options['--runtime'] });
  } else throw new Error('Usage: node backfill.mjs prepare --stage ABS_PATH --end YYYY-MM-DD --days 7|30; or import --stage ABS_PATH --runtime ABS_PATH');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.code === 'LOCK_BUSY' ? 'Runtime busy; preparation retained for retry.' : 'Backfill stopped; no last-good measurement was replaced.'); process.exitCode = 1; });
}
