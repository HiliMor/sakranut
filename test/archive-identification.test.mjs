import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { buildArticle, METHOD, shiftDate, topUrl, windowFor } from '../data-lib.mjs';
import { archiveSnapshotUrl, createEditionController, validateArchive } from '../src/archive-state.js';
import { DESCRIPTION_SOURCE, descriptionFor, identificationMarkup, validateDescriptions } from '../src/identification.js';
import { loadReadingData } from '../src/reading-data.js';
import { archiveProjection, publishArchive } from '../archive-products.mjs';
import { DESCRIPTION_BATCH_SIZE, DESCRIPTION_CACHE_MS, descriptionRequestUrl, descriptionsFromResponse, publishDescriptions } from '../description-products.mjs';
import { updateReadingProducts } from '../reading-products.mjs';
import { atomicJson, readJson, runtimePaths } from '../runtime-lib.mjs';
import { runDaily } from '../run-daily.mjs';

const quiet = { log() {}, warn() {}, error() {} };
const now = new Date('2026-10-03T16:30:00Z');
const baseUrl = new URL('https://example.org/sakranut/');
const fixture = (date = '2026-10-02', title = 'ישראל') => {
  const { seriesStart, baselineStart, baselineEnd } = windowFor(date);
  const items = Array.from({ length: 35 }, (_, i) => ({ timestamp: `${shiftDate(seriesStart, i).replaceAll('-', '')}00`, views: i === 34 ? 1000 : 100 }));
  return { schemaVersion: 1, generatedAt: `${shiftDate(date, 1)}T03:20:00Z`, dataDate: date, seriesStart, baselineStart, baselineEnd,
    source: { name: 'Wikimedia Analytics API', license: 'CC0 1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', url: 'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html', policyUrl: 'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html', topUrl: topUrl(date) },
    method: structuredClone(METHOD), coverage: { requestedDate: date, fallbackDays: 0, topListCount: 1, candidateCount: 1, articleCount: 1, failures: [] },
    articles: [buildArticle({ article: title, rank: 1 }, items, date)], uncomparedArticles: [] };
};
const index = (dates = ['2026-10-01', '2026-10-02']) => ({ schemaVersion: 1, generatedAt: now.toISOString(), latestDate: dates.at(-1), latestGeneratedAt: fixture(dates.at(-1)).generatedAt, availableDates: dates });
const description = { title: 'ישראל', entityId: 'Q801', description: 'מדינה במזרח התיכון', fetchedAt: now.toISOString() };
const metadata = (items = [description]) => ({ schemaVersion: 1, generatedAt: now.toISOString(), source: { ...DESCRIPTION_SOURCE }, items });
const api = (titles, { descriptionText = 'תיאור קצר' } = {}) => ({ batchcomplete: true, query: { pages: titles.map((title, i) => ({
  pageid: i + 1, ns: 0, title: title.replaceAll('_', ' '), pageprops: { wikibase_item: `Q${i + 1}` }, terms: descriptionText ? { description: [descriptionText] } : {},
})) } });
async function runtime(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sakranut-reading-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const network = calls => async (url, options) => {
  calls?.push({ url: String(url), options });
  return Response.json(api(new URL(url).searchParams.get('titles').split('|')));
};
const opts = dir => ({ runtimeDir: dir, now, logger: quiet, waitImpl: async () => {} });

test('archive URLs reject impossible dates, traversal and query injection', () => {
  assert.equal(archiveSnapshotUrl(baseUrl, '2026-10-01'), 'https://example.org/sakranut/data/archive/2026-10-01.json');
  for (const bad of ['../../runner-state', '2026-02-30', '2026-10-01?x=1', '', null]) assert.throws(() => archiveSnapshotUrl(baseUrl, bad));
  for (const availableDates of [['2026-10-02', '2026-10-01'], ['2026-10-01', '2026-10-01'], ['2026-02-30'], ['2026-10-03'], []]) assert.throws(() => validateArchive({ ...index(), availableDates }));
});
test('edition selection keeps historical data stable while latest updates and returns explicitly', async () => {
  const editions = createEditionController({ loadSnapshot: async date => fixture(date) });
  editions.setLatest(fixture()); editions.setArchive(index());
  await editions.select('2026-10-01');
  assert.equal(editions.historical, true);
  editions.setLatest(fixture('2026-10-03'));
  assert.equal(editions.displayed.dataDate, '2026-10-01');
  assert.equal(editions.latest.dataDate, '2026-10-03');
  editions.showLatest();
  assert.equal(editions.displayed.dataDate, '2026-10-03');
  assert.equal(editions.historical, false);
});
test('archive failure or wrong-date payload retains the displayed day instead of silently falling back', async () => {
  for (const loadSnapshot of [async () => { throw new Error('offline'); }, async () => fixture()]) {
    const editions = createEditionController({ loadSnapshot });
    editions.setLatest(fixture()); editions.setArchive(index());
    await editions.select('2026-10-01');
    assert.equal(editions.displayed.dataDate, '2026-10-02');
    assert.equal(editions.busy, false); assert.equal(editions.historical, false);
    assert.match(editions.error, /לא השתנו/);
    await assert.rejects(editions.select('2026-09-30'), /Unavailable/);
  }
});
test('late archive responses cannot overwrite a newer selection or explicit return', async () => {
  let resolves = [];
  const editions = createEditionController({ loadSnapshot: date => new Promise(resolve => resolves.push(() => resolve(fixture(date)))) });
  editions.setLatest(fixture()); editions.setArchive(index(['2026-09-30', '2026-10-01', '2026-10-02']));
  const first = editions.select('2026-09-30'), second = editions.select('2026-10-01');
  resolves[1](); await second; resolves[0](); await first;
  assert.equal(editions.displayed.dataDate, '2026-10-01');
  resolves = []; const pending = editions.select('2026-09-30'); editions.showLatest(); resolves[0](); await pending;
  assert.equal(editions.displayed.dataDate, '2026-10-02'); assert.equal(editions.historical, false);
});
test('only available dates appear; missing archive is latest-only and advertised future dates are excluded', () => {
  const editions = createEditionController({ loadSnapshot: async () => {} });
  editions.setLatest(fixture()); assert.deepEqual(editions.dates, ['2026-10-02']);
  editions.setArchive(index(['2026-09-30', '2026-10-02', '2026-10-04']));
  assert.deepEqual(editions.dates, ['2026-09-30', '2026-10-02']);
});
test('archive projections whitelist nested fields without altering measurement or partial-history semantics', () => {
  const source = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
  source.operatorSecret = 'private'; source.articles[0].privateNote = 'private'; source.articles[0].series[0].privateNote = 'private';
  source.source.operatorSecret = 'private'; source.method.internalPath = 'private'; source.coverage.failures[0].privateNote = 'private';
  const safe = archiveProjection(source);
  assert.doesNotMatch(JSON.stringify(safe), /operatorSecret|privateNote|internalPath/);
  assert.equal(safe.articles[0].ratio, source.articles[0].ratio);
  assert.deepEqual(safe.uncomparedArticles, source.uncomparedArticles);
});
test('public archive exports valid days only, skips gaps and invalid/mismatched/future history', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  await atomicJson(join(paths.history, '2026-09-29.json'), fixture('2026-09-29'));
  await atomicJson(join(paths.history, '2026-09-30.json'), { schemaVersion: 1 });
  await atomicJson(join(paths.history, '2026-10-01.json'), fixture('2026-09-30'));
  await atomicJson(join(paths.history, '2026-10-02.json'), fixture());
  await atomicJson(join(paths.history, '2026-10-04.json'), fixture('2026-10-04'));
  await atomicJson(join(paths.history, 'revisions', '2026-10-01.json'), fixture('2026-10-01'));
  const result = await publishArchive({ ...opts(dir), snapshot: fixture() });
  assert.deepEqual(result.index.availableDates, ['2026-09-29', '2026-10-02']);
  assert.equal(await readJson(join(paths.archive, '2026-10-01.json')), null);
  assert.equal(await readJson(join(paths.archive, '2026-10-02.json')).then(x => x.dataDate), '2026-10-02');
  const before = await readFile(paths.archiveIndex, 'utf8');
  assert.equal((await publishArchive({ ...opts(dir), snapshot: fixture() })).changed, false);
  assert.equal(await readFile(paths.archiveIndex, 'utf8'), before);
});
test('Wikidata requests are exact hewiki sitelinks, Hebrew only, bounded and maxlag-aware', () => {
  const url = descriptionRequestUrl(['סאמי_אבו_שחאדה', 'ישראל']);
  assert.equal(url.origin, 'https://he.wikipedia.org'); assert.equal(url.pathname, '/w/api.php');
  assert.equal(url.searchParams.get('titles'), 'סאמי אבו שחאדה|ישראל');
  for (const [key, value] of Object.entries({ action: 'query', prop: 'pageprops|pageterms', ppprop: 'wikibase_item', wbptlanguage: 'he', wbptterms: 'description', maxlag: '5' })) assert.equal(url.searchParams.get(key), value);
  assert.equal(url.searchParams.has('redirects'), false);
  assert.throws(() => descriptionRequestUrl(Array(21).fill('ישראל')));
  assert.throws(() => descriptionRequestUrl(['ישראל|ישות אחרת']));
});
test('entity identification cannot be guessed by name or imported from the wrong language/entity', () => {
  assert.equal(descriptionsFromResponse(api(['סאמי אבו שחאדה']), ['סאמי_אבו_שחאדה'], now.toISOString())[0].entityId, 'Q1');
  assert.throws(() => descriptionsFromResponse(api(['אחר']), ['ישראל'], now.toISOString()), /Mismatched/);
  assert.throws(() => descriptionsFromResponse({ entities: {} }, ['ישראל'], now.toISOString()));
  assert.throws(() => descriptionsFromResponse({ error: { code: 'maxlag' } }, ['ישראל'], now.toISOString()));
  const unlinked = api(['ישראל']); delete unlinked.query.pages[0].pageprops;
  assert.equal(descriptionsFromResponse(unlinked, ['ישראל'], now.toISOString())[0].description, null);
  assert.equal(descriptionsFromResponse(api(['ישראל'], { descriptionText: null }), ['ישראל'], now.toISOString())[0].description, null);
  const missing = descriptionsFromResponse({ batchcomplete: true, query: { pages: [{ ns: 0, missing: true, title: 'ישראל' }] } }, ['ישראל'], now.toISOString());
  assert.equal(missing[0].entityId, null); assert.equal(missing[0].description, null);
});
test('description projection escapes text, links only to a validated QID and abstains when absent', () => {
  const data = validateDescriptions(metadata([{ ...description, title: 'שם_מלא', description: '<script>"בדיקה" & מחר</script>' }]));
  assert.equal(descriptionFor(data, 'שם מלא').entityId, 'Q801');
  const html = identificationMarkup(data, 'שם מלא', { detail: true });
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
  assert.match(html, /https:\/\/www\.wikidata\.org\/wiki\/Q801/); assert.match(html, /אינו הסבר/);
  assert.equal(identificationMarkup(data, 'שם אחר'), '');
  for (const patch of [{ entityId: 'Q1?secret=bad' }, { description: '' }, { fetchedAt: 'tomorrow' }, { fetchedAt: '2027-01-01T00:00:00Z' }]) assert.throws(() => validateDescriptions(metadata([{ ...description, ...patch }])));
  assert.throws(() => validateDescriptions(metadata([description, description])));
});
test('description retrieval caches seven days, skips no-op requests, retains old-edition descriptions', async t => {
  const dir = await runtime(t), calls = [], fetchImpl = network(calls);
  const first = await publishDescriptions({ ...opts(dir), titles: ['אומן', 'ישראל'], currentTitles: ['ישראל'], fetchImpl });
  assert.equal(first.requests, 1); assert.equal(calls.length, 1);
  const bytes = await readFile(runtimePaths(dir).descriptions, 'utf8');
  const second = await publishDescriptions({ ...opts(dir), now: new Date(now.getTime() + 3 * 3600000), titles: [], currentTitles: ['ישראל'], fetchImpl });
  assert.equal(second.requests, 0); assert.equal(await readFile(runtimePaths(dir).descriptions, 'utf8'), bytes);
  await publishDescriptions({ ...opts(dir), now: new Date(now.getTime() + DESCRIPTION_CACHE_MS), titles: [], currentTitles: ['ישראל'], fetchImpl });
  assert.equal(calls.length, 2); assert.equal(new URL(calls[1].url).searchParams.get('titles'), 'ישראל');
  assert.equal((await readJson(runtimePaths(dir).descriptions)).items.length, 2);
});
test('optional failure retains cached descriptions, honors Retry-After and does not retry other batches', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  await publishDescriptions({ ...opts(dir), titles: ['ישראל'], fetchImpl: network() });
  const bytes = await readFile(paths.descriptions, 'utf8');
  let calls = 0;
  const blocked = await publishDescriptions({ ...opts(dir), titles: Array.from({ length: 25 }, (_, i) => `ערך${i}`), fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '86400' } }); } });
  assert.equal(blocked.requests, 1); assert.equal(calls, 1); assert.equal(await readFile(paths.descriptions, 'utf8'), bytes);
  const again = await publishDescriptions({ ...opts(dir), now: new Date(now.getTime() + 3 * 3600000), titles: [], currentTitles: ['ישראל'], fetchImpl: network() });
  assert.equal(again.requests, 0); assert.equal(again.pending, 25);
  const recovered = await publishDescriptions({ ...opts(dir), now: new Date(now.getTime() + 86400000), titles: [], currentTitles: ['ישראל'], fetchImpl: network() });
  assert.equal(recovered.requests, 2); assert.equal(recovered.pending, 0);
});
test('retrieval is at most two sequential 20-title batches and preserves pending titles for a later run', async t => {
  const dir = await runtime(t), calls = [];
  const titles = Array.from({ length: 45 }, (_, i) => `ערך_${i}`);
  const first = await publishDescriptions({ ...opts(dir), titles, fetchImpl: network(calls) });
  assert.equal(first.requests, 2); assert.equal(first.pending, 5);
  assert(calls.every(call => new URL(call.url).searchParams.get('titles').split('|').length <= DESCRIPTION_BATCH_SIZE));
  assert(calls.every(call => call.options.redirect === 'error' && call.options.signal instanceof AbortSignal));
  const rest = await publishDescriptions({ ...opts(dir), titles: [], currentTitles: [], fetchImpl: network() });
  assert.equal(rest.requests, 1); assert.equal(rest.pending, 0); assert.equal(rest.described, 45);
});
test('missing descriptions are negatively cached, not invented or converted into measurement failures', async t => {
  const dir = await runtime(t);
  const fetchImpl = async url => Response.json(api(new URL(url).searchParams.get('titles').split('|'), { descriptionText: null }));
  const result = await publishDescriptions({ ...opts(dir), titles: ['ישראל'], fetchImpl });
  assert.equal(result.described, 0); assert.equal(result.pending, 0);
  assert.equal((await publishDescriptions({ ...opts(dir), titles: ['ישראל'], fetchImpl: () => { throw new Error('No repeat fetch'); } })).requests, 0);
  assert.deepEqual((await readJson(runtimePaths(dir).descriptions)).items, []);
});
test('corrupt private cache cannot wipe last-good public descriptions on optional network failure', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  await publishDescriptions({ ...opts(dir), titles: ['ישראל'], fetchImpl: network() });
  const before = await readFile(paths.descriptions, 'utf8');
  await atomicJson(paths.descriptionCache, { schemaVersion: 99 });
  await publishDescriptions({ ...opts(dir), titles: ['ערך חדש'], currentTitles: ['ערך חדש'], fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await readFile(paths.descriptions, 'utf8'), before);
});
test('server reading aids run autonomously without changing measurement bytes, runner status or reviewed context', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir), snapshot = fixture();
  await atomicJson(paths.snapshot, snapshot); await atomicJson(join(paths.history, `${snapshot.dataDate}.json`), snapshot);
  const before = await readFile(paths.snapshot, 'utf8');
  await updateReadingProducts({ ...opts(dir), snapshot, fetchImpl: network() });
  assert.equal(await readFile(paths.snapshot, 'utf8'), before);
  assert.equal(await readJson(paths.status), null); assert.equal(await readJson(paths.state), null);
  assert.equal(await stat(join(dir, 'public/context.json')).then(() => true, () => false), false);
  assert.equal((await readJson(paths.archiveIndex)).availableDates[0], snapshot.dataDate);
});
test('runner commits measurement status first; optional aid exception cannot mark a good run failed', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  const result = await runDaily({ runtimeDir: dir, now: () => now, healthcheckUrl: '', logger: quiet, lock: (_dir, work) => work(), collect: async () => fixture(),
    updateProducts: async () => { assert.equal((await readJson(paths.status)).state, 'healthy'); throw new Error('private upstream detail'); } });
  assert.equal(result.exitCode, 0); assert.equal(result.status.state, 'healthy'); assert.equal(result.published, true);
  assert.doesNotMatch(JSON.stringify(result.status), /private upstream/);
});
test('optional browser products fail independently, retain last-good records, and permit local latest-only mode', async () => {
  const calls = [];
  const loaded = await loadReadingData({ baseUrl, fetchImpl: async url => { calls.push(String(url)); return Response.json(String(url).endsWith('archive.json') ? index() : metadata()); } });
  assert.deepEqual(loaded.archive, index()); assert.equal(loaded.descriptions.items[0].entityId, 'Q801');
  assert(calls.every(url => url.startsWith('https://example.org/sakranut/data/')));
  const fail = await loadReadingData({ baseUrl, previousArchive: loaded.archive, previousDescriptions: loaded.descriptions, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(fail.archive, loaded.archive); assert.deepEqual(fail.descriptions, loaded.descriptions); assert(fail.archiveError);
  const local = await loadReadingData({ baseUrl, fetchImpl: async () => new Response('index.html', { headers: { 'content-type': 'text/html' } }) });
  assert.equal(local.archive, null); assert.equal(local.descriptions, null); assert.equal(local.archiveError, null);
});
test('UI keeps archive mode explicit and snapshot links tied to the displayed day, health tied to latest', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(main, /deriveLiveState\(edition\.latest,/);
  assert.match(main, /previousSnapshot: edition\.latest/);
  assert.match(main, /edition\.historical \? 'מהארכיון'/);
  assert.match(main, /displayedSnapshotUrl\(\)/);
  assert.match(main, /if \(edition\.busy\) return/);
  assert.match(html, /label for="edition-select"/); assert.match(html, /id="edition-latest"[^>]*hidden/);
  assert.match(html, /id="archive-state" role="status" aria-live="polite"/);
  const nginx = readFileSync(new URL('../ops/wiki-interest/nginx-private.conf', import.meta.url), 'utf8');
  assert.match(nginx, /listen 127\.0\.0\.1:4174/); assert.match(nginx, /public\/archive\/\$archive_date\.json/);
  assert.doesNotMatch(nginx, /alias \/var\/lib\/wiki-interest\/(?:history|description-cache|runner-state)/);
});
