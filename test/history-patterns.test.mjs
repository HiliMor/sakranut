import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { articleRangeUrl, buildArticle, METHOD, shiftDate, topUrl, windowFor } from '../data-lib.mjs';
import { prepareBackfill, importBackfill } from '../backfill.mjs';
import { archiveProjection, publishArchive } from '../archive-products.mjs';
import { atomicJson, readJson, runtimePaths } from '../runtime-lib.mjs';
import { parseRange, publishTracks } from '../tracking-products.mjs';
import { TRACKING_DAYS, trackedArticles, validateTracks, weeklyPatterns } from '../src/tracking-lib.js';
import { patternsMarkup } from '../src/patterns-view.js';
import { loadReadingData } from '../src/reading-data.js';

const now = new Date('2026-10-03T18:00:00Z'), endDate = '2026-10-02';
const quiet = { log() {}, warn() {} }, noWait = async () => {};
const pointItems = (from, through, views = () => 100) => {
  const result = [];
  for (let date = from; date <= through; date = shiftDate(date, 1)) result.push({ timestamp: `${date.replaceAll('-', '')}00`, views: views(date) });
  return result;
};
const fixture = (date = endDate, title = 'ישראל', views = () => 100) => ({
  schemaVersion: 1, generatedAt: `${shiftDate(date, 1)}T03:20:00Z`, dataDate: date, ...windowFor(date),
  source: { name: 'Wikimedia Analytics API', license: 'CC0 1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    url: 'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html',
    policyUrl: 'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html', topUrl: topUrl(date) },
  method: structuredClone(METHOD), coverage: { requestedDate: date, fallbackDays: 0, topListCount: 1, candidateCount: 1, articleCount: 1, failures: [] },
  articles: [buildArticle({ article: title, rank: 1 }, pointItems(windowFor(date).seriesStart, date, views), date)], uncomparedArticles: [],
});
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'sakranut-pattern-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const product = (items, availableDates = [endDate]) => validateTracks({ schemaVersion: 1, generatedAt: now.toISOString(), dataDate: endDate,
  periodStart: shiftDate(endDate, -(TRACKING_DAYS - 1)), seriesStart: windowFor(shiftDate(endDate, -(TRACKING_DAYS - 1))).seriesStart,
  availableDates, items });
const tracked = (title, values, sampleDates = [endDate]) => ({ title, sampleDates,
  series: pointItems(windowFor(endDate).seriesStart, endDate, date => values[date] ?? 100)
    .map(item => ({ date: `${item.timestamp.slice(0, 4)}-${item.timestamp.slice(4, 6)}-${item.timestamp.slice(6, 8)}`, views: item.views })) });
function network(calls = [], { omitDate = null, unavailableTitle = null } = {}) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    const parts = new URL(url).pathname.split('/');
    if (parts.includes('top')) {
      const date = parts.slice(-3).join('-');
      if (date === omitDate) return new Response('', { status: 404 });
      const titles = date === '2026-10-01' ? ['ישראל', 'ירושלים'] : ['ישראל', 'חיפה'];
      const [year, month, day] = date.split('-');
      return Response.json({ items: [{ year, month, day, articles: titles.map((article, i) => ({ article, rank: i + 1, views: 100 })) }] });
    }
    const title = decodeURIComponent(parts.at(-4));
    if (title === unavailableTitle) return new Response('', { status: 404 });
    const iso = stamp => `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
    return Response.json({ items: pointItems(iso(parts.at(-2)), iso(parts.at(-1))) });
  };
}

test('range parsing rejects malformed/duplicate/out-of-window/negative counts; never fills gaps', () => {
  const items = pointItems('2026-10-01', endDate, date => date === endDate ? 0 : 5);
  assert.deepEqual(parseRange([items[1]], '2026-10-01', endDate), [{ date: endDate, views: 0 }]);
  for (const bad of [[], [items[0], items[0]], [{ timestamp: '2026023000', views: 1 }], [{ timestamp: '2026100300', views: 1 }], [{ ...items[0], views: -1 }]]) {
    assert.throws(() => parseRange(bad, '2026-10-01', endDate));
  }
});
test('tracking projection validates coverage, dates, titles and removes private fields', () => {
  const record = tracked('ישראל', {}), safe = product([{ ...record, privateNote: 'secret' }]);
  assert.doesNotMatch(JSON.stringify(safe), /secret|privateNote/);
  for (const patch of [{ series: [{ date: endDate, views: null }] }, { sampleDates: ['2026-10-03'] }, { sampleDates: [endDate, endDate] }, { title: 'ישראל|אחר' }]) {
    assert.throws(() => product([{ ...record, ...patch }]));
  }
  assert.throws(() => product([record, record]));
  assert.throws(() => validateTracks({ ...safe, availableDates: ['2026-02-30', endDate] }));
});
test('weekly patterns distinguish an observed persistent run from a recovered peak', () => {
  const persistent = tracked('נשאר', { '2026-09-30': 800, '2026-10-01': 900, '2026-10-02': 700 });
  const cooled = tracked('נרגע', { '2026-09-28': 1500 });
  const patterns = weeklyPatterns(product([persistent, cooled]), endDate);
  assert.equal(patterns.persistent[0].title, 'נשאר'); assert.equal(patterns.persistent[0].activeDays, 3);
  assert.equal(patterns.cooled[0].title, 'נרגע'); assert.equal(patterns.cooled[0].peakDate, '2026-09-28');
  assert.equal(patterns.comparedCount, 2);
});
test('missing comparison days and low baselines abstain; observed zero remains a measurement', () => {
  const missing = tracked('חסר', { '2026-09-28': 1500 }); missing.series.splice(20, 1);
  const low = tracked('בסיס קטן', {}); low.series.forEach((point, i) => { point.views = i < 28 ? 0 : 1000; });
  const zero = tracked('אפס', { '2026-09-28': 1500, '2026-10-01': 0, '2026-10-02': 0 });
  const result = weeklyPatterns(product([missing, low, zero]), endDate);
  assert.equal(result.comparedCount, 1); assert.equal(result.candidateCount, 3);
  assert.equal(result.cooled[0].views, 0); assert.deepEqual(result.persistent, []);
});
test('an old edition cannot see future-discovered titles or future counts', () => {
  const oldDate = '2026-10-01';
  const records = [tracked('מוקדם', { '2026-10-02': 99999 }, [oldDate]), tracked('מאוחר', {}, [endDate])];
  records[0].series.unshift({ date: shiftDate(windowFor(endDate).seriesStart, -1), views: 100 });
  const all = trackedArticles(product(records, [oldDate, endDate]), oldDate);
  assert.equal(all.length, 1); assert.equal(all[0].title, 'מוקדם'); assert.equal(all[0].views, 100);
  assert.equal(all[0].series.at(-1).date, oldDate);
});
test('a high point needs two subsequent below-threshold days to count as cooled', () => {
  const tooRecent = tracked('אתמול', { '2026-10-01': 1500 });
  const stillHigh = tracked('עדיין גבוה', { '2026-09-28': 1500, '2026-10-02': 300 });
  assert.deepEqual(weeklyPatterns(product([tooRecent, stillHigh]), endDate).cooled, []);
});
test('weekly view escapes titles, exposes dated evidence and does not claim an explanation', () => {
  const html = patternsMarkup(product([tracked('<בדיקה>', { '2026-09-28': 1500 })]), endDate);
  assert.match(html, /&lt;בדיקה&gt;/); assert.doesNotMatch(html, /<בדיקה>/);
  assert.match(html, /tracks\.json/); assert.match(html, /לא הסברים לסיבה/); assert.match(html, /מעקב שבועי/);
  assert.equal(patternsMarkup(null, endDate), '');
});
test('a dropped top-list title is updated with its measured tail; repeat checks are network-free', async t => {
  const dir = await temp(t), paths = runtimePaths(dir);
  await atomicJson(join(paths.history, '2026-10-01.json'), fixture('2026-10-01', 'ירושלים'));
  await atomicJson(join(paths.history, `${endDate}.json`), fixture());
  const calls = [], options = { runtimeDir: dir, snapshot: fixture(), now, logger: quiet, waitImpl: noWait, fetchImpl: network(calls) };
  const result = await publishTracks(options);
  assert.equal(result.requests, 1); assert.equal(result.pending, 0);
  assert.equal(calls[0].url, articleRangeUrl('ירושלים', endDate, endDate));
  const data = await readJson(paths.tracks);
  assert.equal(trackedArticles(data, endDate).find(item => item.title === 'ירושלים').views, 100);
  const bytes = await readFile(paths.tracks, 'utf8');
  const repeat = await publishTracks({ ...options, now: new Date(now.getTime() + 3600000) });
  assert.equal(repeat.requests, 0); assert.equal(repeat.changed, false); assert.equal(await readFile(paths.tracks, 'utf8'), bytes);
});
test('tracking respects its per-run request budget and never overwrites a last-good measurement', async t => {
  const dir = await temp(t), paths = runtimePaths(dir);
  for (const [date, title] of [['2026-09-29', 'א'], ['2026-09-30', 'ב'], ['2026-10-01', 'ג'], [endDate, 'ישראל']]) await atomicJson(join(paths.history, `${date}.json`), fixture(date, title));
  await atomicJson(paths.snapshot, fixture()); await atomicJson(paths.status, { privateStatus: 'retained' });
  const before = await readFile(paths.snapshot, 'utf8'), calls = [];
  const result = await publishTracks({ runtimeDir: dir, snapshot: fixture(), now, logger: quiet, fetchImpl: network(calls), waitImpl: noWait, maxRequests: 1 });
  assert.equal(result.requests, 1); assert.equal(result.pending, 2);
  assert.equal(await readFile(paths.snapshot, 'utf8'), before); assert.deepEqual(await readJson(paths.status), { privateStatus: 'retained' });
});
test('tracking failure keeps unknown days unknown and retries no sooner than the next scheduled interval', async t => {
  const dir = await temp(t), paths = runtimePaths(dir);
  await atomicJson(join(paths.history, '2026-10-01.json'), fixture('2026-10-01', 'ירושלים'));
  const calls = [], options = { runtimeDir: dir, snapshot: fixture(), now, logger: quiet, fetchImpl: network(calls, { unavailableTitle: 'ירושלים' }), waitImpl: noWait };
  assert.equal((await publishTracks(options)).failures, 1);
  const data = await readJson(paths.tracks);
  assert.equal(data.items.find(item => item.title === 'ירושלים').series.some(point => point.date === endDate), false);
  assert.equal((await publishTracks({ ...options, now: new Date(now.getTime() + 3600000) })).requests, 0);
});
test('publisher Retry-After backs off the whole tracking queue, not just one title', async t => {
  const dir = await temp(t), paths = runtimePaths(dir);
  await atomicJson(join(paths.history, '2026-10-01.json'), fixture('2026-10-01', 'ירושלים'));
  let calls = 0;
  const options = { runtimeDir: dir, snapshot: fixture(), now, logger: quiet, waitImpl: noWait,
    fetchImpl: async () => { calls += 1; return new Response('', { status: 429, headers: { 'Retry-After': '86400' } }); } };
  assert.equal((await publishTracks(options)).requests, 1);
  const retryAt = (await readJson(paths.trackingCache)).retryAt;
  assert(Date.parse(retryAt) > now.getTime() + 20 * 3600000);
  assert.equal((await publishTracks({ ...options, now: new Date(now.getTime() + 4 * 3600000) })).requests, 0);
  assert.equal(calls, 1);
});
test('bad request budgets and future-generated private history cannot expand tracking', async t => {
  const dir = await temp(t), paths = runtimePaths(dir);
  await atomicJson(join(paths.history, '2026-10-01.json'), { ...fixture('2026-10-01', 'עתיד'), generatedAt: '2027-01-01T00:00:00Z' });
  const options = { runtimeDir: dir, snapshot: fixture(), now, logger: quiet, fetchImpl: network(), waitImpl: noWait };
  for (const patch of [{ maxRequests: 81 }, { maxRequests: -1 }, { maxDurationMs: 60001 }]) await assert.rejects(publishTracks({ ...options, ...patch }));
  assert.deepEqual((await publishTracks(options)).titles, ['ישראל']);
});
test('a title expires from the active cohort after 30 days without discarding its saved archive', async t => {
  const dir = await temp(t), paths = runtimePaths(dir);
  const expired = shiftDate(endDate, -30);
  await atomicJson(join(paths.history, `${expired}.json`), fixture(expired, 'ישן'));
  const result = await publishTracks({ runtimeDir: dir, snapshot: fixture(), now, logger: quiet, fetchImpl: network(), waitImpl: noWait });
  assert.deepEqual(result.titles, ['ישראל']);
  assert.equal((await readJson(join(paths.history, `${expired}.json`))).articles[0].title, 'ישן');
});
test('backfill uses each historical top list and reuses overlapping article series', async t => {
  const dir = await temp(t), calls = [];
  const report = await prepareBackfill({ stageDir: dir, endDate, days: 2, now: () => now, logger: quiet, fetchImpl: network(calls), waitImpl: noWait });
  assert.equal(report.requests, 5); assert.equal(report.uniqueTitles, 3); assert.equal(report.failures.length, 0);
  const first = await readJson(join(dir, 'prepared-history/2026-10-01.json'));
  const last = await readJson(join(dir, `prepared-history/${endDate}.json`));
  assert.deepEqual(first.articles.map(item => item.title), ['ישראל', 'ירושלים']);
  assert.deepEqual(last.articles.map(item => item.title), ['ישראל', 'חיפה']);
  assert.equal(first.collectionOrigin, 'retrospective'); assert.equal(first.generatedAt, now.toISOString());
  assert.equal(first.coverage.requestedDate, '2026-10-01'); assert.equal(first.coverage.fallbackDays, 0);
  assert(calls.every(call => call.options.headers['User-Agent'].includes('Sakranut/')));
  const repeated = await prepareBackfill({ stageDir: dir, endDate, days: 2, now: () => now, logger: quiet, fetchImpl: network(calls), waitImpl: noWait });
  assert.equal(repeated.requests, 0);
});
test('unavailable top-list days remain gaps, with no fallback date substituted', async t => {
  const dir = await temp(t);
  const result = await prepareBackfill({ stageDir: dir, endDate, days: 2, now: () => now, logger: quiet, fetchImpl: network([], { omitDate: '2026-10-01' }), waitImpl: noWait });
  assert.deepEqual(result.preparedDates, [endDate]);
  assert.equal(await readJson(join(dir, 'prepared-history/2026-10-01.json')), null);
  assert.equal(result.failures[0].reason, 'Top list unavailable');
});
test('insufficient historical coverage does not lower the existing 75-percent quality gate', async t => {
  const dir = await temp(t);
  const report = await prepareBackfill({ stageDir: dir, endDate, days: 1, now: () => now, logger: quiet, fetchImpl: network([], { unavailableTitle: 'חיפה' }), waitImpl: noWait });
  assert.deepEqual(report.preparedDates, []); assert.equal(report.failures[0].reason, 'Insufficient complete histories');
});
test('backfill stops on publisher rate limits without publishing to the live runtime', async t => {
  const dir = await temp(t);
  await assert.rejects(prepareBackfill({ stageDir: dir, endDate, days: 1, now: () => now, logger: quiet, waitImpl: noWait,
    fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }) }), error => error.code === 'STOP_COLLECTION');
  assert.equal(await readJson(join(dir, 'public/snapshot.json')), null);
});
test('preparation rejects unbounded, incomplete-day and non-dedicated targets before any request', async t => {
  const dir = await temp(t);
  for (const patch of [{ days: 0 }, { days: 31 }, { days: NaN }, { endDate: '2026-10-03' }, { endDate: '2026-02-30' }, { stageDir: '/' }]) {
    await assert.rejects(prepareBackfill({ stageDir: dir, endDate, days: 7, now: () => now, fetchImpl: () => { assert.fail('No request permitted'); }, ...patch }));
  }
});
test('reviewed import is additive under one lock; snapshot, status, state and existing history bytes are retained', async t => {
  const root = await temp(t), stageDir = join(root, 'stage'), runtimeDir = join(root, 'runtime'), paths = runtimePaths(runtimeDir);
  await prepareBackfill({ stageDir, endDate, days: 2, now: () => now, logger: quiet, fetchImpl: network(), waitImpl: noWait });
  const current = fixture();
  await atomicJson(paths.snapshot, current); await atomicJson(paths.status, { healthy: true }); await atomicJson(paths.state, { lastSuccessAt: 'retained' });
  await atomicJson(join(paths.history, `${endDate}.json`), current);
  const protectedPaths = [paths.snapshot, paths.status, paths.state, join(paths.history, `${endDate}.json`)];
  const before = await Promise.all(protectedPaths.map(path => readFile(path, 'utf8')));
  let locks = 0;
  const result = await importBackfill({ runtimeDir, stageDir, now, logger: quiet, lock: async (_, work) => { locks += 1; return work(); } });
  assert.deepEqual(result, { added: 1, retained: 1 }); assert.equal(locks, 1);
  assert.deepEqual(await Promise.all(protectedPaths.map(path => readFile(path, 'utf8'))), before);
  assert.deepEqual((await readJson(paths.archiveIndex)).availableDates, ['2026-10-01', endDate]);
});
test('a forced archive refresh exposes newly imported days without replacing the latest edition', async t => {
  const dir = await temp(t), paths = runtimePaths(dir);
  await atomicJson(join(paths.history, `${endDate}.json`), fixture());
  await publishArchive({ runtimeDir: dir, snapshot: fixture(), now, logger: quiet });
  await atomicJson(join(paths.history, '2026-10-01.json'), { ...fixture('2026-10-01'), collectionOrigin: 'retrospective' });
  await publishArchive({ runtimeDir: dir, snapshot: fixture(), now, logger: quiet, force: true });
  assert.deepEqual((await readJson(paths.archiveIndex)).availableDates, ['2026-10-01', endDate]);
  assert.equal((await readJson(join(paths.archive, '2026-10-01.json'))).collectionOrigin, 'retrospective');
  assert.throws(() => archiveProjection({ ...fixture(), collectionOrigin: 'imaginary' }));
});
test('a corrupt prepared date is rejected before the import lock or live writes', async t => {
  const dir = await temp(t);
  await atomicJson(join(dir, 'backfill-report.json'), { schemaVersion: 1, requestedDays: 1, startDate: endDate, endDate, preparedDates: [endDate] });
  await atomicJson(join(dir, `prepared-history/${endDate}.json`), fixture('2026-10-01'));
  await assert.rejects(importBackfill({ runtimeDir: join(dir, 'runtime'), stageDir: dir, now, lock: () => { assert.fail('Must validate before locking'); } }));
});
test('optional tracking fetch failures retain prior valid products independently of archive and descriptions', async () => {
  const previousTracks = product([tracked('ישראל', {})]);
  const result = await loadReadingData({ baseUrl: new URL('https://example.org/'), previousTracks,
    fetchImpl: async url => String(url).endsWith('tracks.json') ? Response.json({ items: ['invalid'] }) : new Response('', { status: 404 }) });
  assert.equal(result.tracks, previousTracks); assert(result.trackingError); assert.equal(result.archiveError, null);
});
test('tracking revalidates the browser cache while measurement metadata remains no-store', async () => {
  const calls = [];
  await loadReadingData({ baseUrl: new URL('https://example.org/'), fetchImpl: async (url, options) => { calls.push({ url: String(url), cache: options.cache }); return new Response('', { status: 404 }); } });
  assert.equal(calls.find(call => call.url.endsWith('tracks.json')).cache, 'no-cache');
  assert.equal(calls.find(call => call.url.endsWith('archive.json')).cache, 'no-store');
});
