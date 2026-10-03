import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildArticle } from '../data-lib.mjs';
import { buildResearchQueue } from '../src/context-pilot-lib.js';
import { probeRelatedSources } from '../src/related-sources.js';

const fixture = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
const queue = buildResearchQueue(fixture);
const now = () => new Date('2026-10-02T14:00:00Z');
const holiday = (overrides = {}) => ({ title: 'הוֹשַׁעְנָא רַבָּה', hebrew: 'הוֹשַׁעְנָא רַבָּה', date: '2026-10-02', category: 'holiday', link: 'https://www.hebcal.com/holidays/hoshana-raba-2026', memo: 'Never copy full body or infer sunset time', ...overrides });
const article = (overrides = {}) => ({ title: 'יעקב עמידרור בכותרת', url: 'https://example.org/news/item', seendate: '20261001T134500Z', socialimage: 'https://example.org/private-image.jpg', ...overrides });
const options = fetchImpl => ({ fetchImpl, now });

test('default uses exactly one bounded Hebcal request and skips optional discovery', async () => {
  const calls = [];
  const result = await probeRelatedSources(queue, options(async (url, init) => { calls.push({ url, init }); return Response.json({ items: [holiday()] }); }));
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://www.hebcal.com/hebcal');
  assert.deepEqual(Object.fromEntries(url.searchParams), { v: '1', cfg: 'json', start: '2026-09-29', end: '2026-10-02', maj: 'on', i: 'on', lg: 'he' });
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(result.sources[0].status, 'ok');
  assert.equal(result.sources[1].status, 'skipped');
  assert.equal(result.sources[1].errorCode, 'discovery_not_requested');
  assert.equal(result.sources[0].fetchedAt, '2026-10-02T14:00:00.000Z');
  assert.equal(result.calendarItems.length, 1);
  assert.deepEqual(result.calendarItems[0], {
    title: 'הושענא רבה', eventTitle: 'הוֹשַׁעְנָא רַבָּה', eventDate: '2026-10-02', url: holiday().link,
    relation: 'next_calendar_date', sourceId: 'hebcal', calendar: 'Hebrew (Israel)', dateBasis: 'civil_date_no_sunset_time',
    attribution: 'Hebcal (CC BY 4.0)', reviewStatus: 'draft',
  });
  assert.deepEqual(result.records, []);
  assert.doesNotMatch(JSON.stringify(result), /Never copy|publishedDate|sunsetAt|summary|approved/);
});

test('calendar exact normalized phrases and explicit ±1 civil dates, never publication dates', async () => {
  const items = [holiday({ date: '2026-09-29' }), holiday({ date: '2026-09-30' }), holiday({ date: '2026-10-01' }), holiday(), holiday(),
    holiday({ title: 'אירוע הושענא רבה נוסף', hebrew: 'אירוע הושענא רבה נוסף' })];
  const result = await probeRelatedSources(queue, options(async () => Response.json({ items })));
  assert.equal(result.sources[0].recordCount, items.length);
  assert.deepEqual(result.calendarItems.map(item => item.relation), ['previous_calendar_date', 'same_calendar_date', 'next_calendar_date']);
  assert.equal(result.calendarItems.length, 3);
  assert.ok(result.calendarItems.every(item => !Object.hasOwn(item, 'publishedDate')));
});

test('reviewed full Hebcal holiday heading matches exactly, including niqqud, not broad substrings', async () => {
  const items = [holiday({ title: 'סוכות ז׳ (הושענא רבה)', hebrew: 'סוּכּוֹת ז׳ (הוֹשַׁעְנָא רַבָּה)' }),
    holiday({ title: 'סוכות ז׳ (הושענא רבה) תוספת', hebrew: 'סוכות ז׳ (הושענא רבה) תוספת' }),
    holiday({ title: 'הושענא רבה', hebrew: 'הושענא רבה', category: 'sedra' })];
  const result = await probeRelatedSources(queue, options(async () => Response.json({ items })));
  assert.equal(result.calendarItems.length, 1);
  assert.equal(result.calendarItems[0].title, 'הושענא רבה');
  assert.equal(result.calendarItems[0].eventTitle, items[0].hebrew);
  assert.equal(result.calendarItems[0].relation, 'next_calendar_date');
  const snapshot = structuredClone(fixture);
  snapshot.articles = [buildArticle({ article: 'פסח', rank: 1 }, fixture.articles[0].series.map(p => ({ timestamp: p.date.replaceAll('-', '') + '00', views: p.views })), fixture.dataDate)];
  snapshot.uncomparedArticles = [];
  snapshot.coverage = { ...snapshot.coverage, candidateCount: 1, articleCount: 1, failures: [] };
  const distinct = await probeRelatedSources(buildResearchQueue(snapshot), options(async () => Response.json({ items: [holiday({ title: 'פסח שני', hebrew: 'פסח שני' })] })));
  assert.deepEqual(distinct.calendarItems, []);
});

test('calendar missing/imprecise/impossible dates and unsafe links are counted, not invented', async () => {
  const items = [holiday(), holiday({ date: '2026-02-30' }), holiday({ date: '2026-10-01T18:00:00+03:00' }), holiday({ date: undefined }),
    holiday({ date: '2026-10-03' }), holiday({ link: 'https://evil.example/fake' }), holiday({ category: null }), holiday({ hebrew: 42 })];
  const result = await probeRelatedSources(queue, options(async () => Response.json({ items })));
  assert.equal(result.sources[0].status, 'ok');
  assert.equal(result.sources[0].invalidRecordCount, 7);
  assert.equal(result.sources[0].recordCount, 1);
  assert.equal(result.calendarItems.length, 1);
  const invalid = await probeRelatedSources(queue, options(async () => Response.json({ items: [holiday({ date: 'not a date' })] })));
  assert.equal(invalid.sources[0].status, 'invalid_response');
  assert.equal(invalid.sources[0].errorCode, 'invalid_records');
});

test('GDELT discovery is one combined fixed-alias query; seendate is never publication', async () => {
  const calls = [];
  const result = await probeRelatedSources(queue, { ...options(async (url, init) => {
    calls.push({ url, init });
    return Response.json(new URL(url).hostname === 'www.hebcal.com' ? { items: [] } : { articles: [article(), article({ url: 'https://example.org/undated', seendate: undefined })] });
  }), includeDiscovery: true });
  assert.equal(calls.length, 2);
  const url = new URL(calls[1].url);
  assert.equal(url.origin + url.pathname, 'https://api.gdeltproject.org/api/v2/doc/doc');
  assert.equal(url.searchParams.get('mode'), 'artlist');
  assert.equal(url.searchParams.get('maxrecords'), '100');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('startdatetime'), '20260929000000');
  assert.equal(url.searchParams.get('enddatetime'), '20261002000000');
  for (const phrase of ['Amidror', '"Hoshana Rabbah"', 'Verity', 'Kosovo', '"Abu Shehadeh"', 'sourcelang:hebrew']) assert.ok(url.searchParams.get('query').includes(phrase));
  assert.equal(result.sources[1].status, 'ok');
  assert.equal(result.records[0].providerSeenAt, '2026-10-01T13:45:00.000Z');
  assert.equal(result.records[0].publishedDate, null);
  assert.equal(result.records[1].publishedDate, null);
  assert.equal(Object.hasOwn(result.records[1], 'providerSeenAt'), false);
  assert.doesNotMatch(JSON.stringify(result.records), /socialimage|private-image|memo|summary/);
  assert.ok(calls.every(call => ['api.gdeltproject.org', 'www.hebcal.com'].includes(new URL(call.url).hostname)));
});

test('unsupported titles never become arbitrary provider query text', async () => {
  const snapshot = structuredClone(fixture);
  snapshot.articles = [buildArticle({ article: 'שם_אחר_לא_נתמך', rank: 1 }, fixture.articles[0].series.map(p => ({ timestamp: p.date.replaceAll('-', '') + '00', views: p.views })), fixture.dataDate)];
  snapshot.uncomparedArticles = [];
  snapshot.coverage = { ...snapshot.coverage, candidateCount: 1, articleCount: 1, failures: [] };
  let calls = 0;
  const result = await probeRelatedSources(buildResearchQueue(snapshot), { ...options(async () => { calls++; return Response.json({ items: [] }); }), includeDiscovery: true });
  assert.equal(calls, 1);
  assert.equal(result.sources[1].status, 'skipped');
  assert.equal(result.sources[1].errorCode, 'no_supported_aliases');
});

test('GDELT invalid observed timestamps/records counted; calendar remains independent', async () => {
  const result = await probeRelatedSources(queue, { ...options(async url => Response.json(new URL(url).hostname === 'www.hebcal.com' ? { items: [holiday()] } : { articles: [article(), article({ seendate: '2026-10-01' }), article({ seendate: '20260230T010000Z' }), article({ seendate: '20261001T240000Z' }), article({ url: 'javascript:alert(1)' }), article({ title: '' })] })), includeDiscovery: true });
  assert.equal(result.sources[1].status, 'ok');
  assert.equal(result.sources[1].recordCount, 1);
  assert.equal(result.sources[1].invalidRecordCount, 5);
  assert.equal(result.records.length, 1);
  assert.equal(result.calendarItems.length, 1);
});

test('429 is unavailable, no automatic retry, no false empty success', async () => {
  const calls = [];
  const result = await probeRelatedSources(queue, { ...options(async url => {
    calls.push(url);
    return new URL(url).hostname === 'www.hebcal.com' ? Response.json({ items: [] }) : new Response('private upstream message', { status: 429, headers: { 'retry-after': '5' } });
  }), includeDiscovery: true });
  assert.equal(calls.length, 2);
  assert.equal(result.sources[1].status, 'unavailable');
  assert.equal(result.sources[1].httpStatus, 429);
  assert.equal(result.sources[1].errorCode, 'http_error');
  assert.doesNotMatch(JSON.stringify(result), /private upstream message/);
  assert.deepEqual(result.records, []);
});

test('network failure and redirects do not expose raw errors or fetch destination', async () => {
  let calls = 0;
  const network = await probeRelatedSources(queue, options(async (_url, init) => { calls++; assert.equal(init.redirect, 'error'); throw new Error('https://credentials.example/secret-token'); }));
  assert.equal(calls, 1);
  assert.equal(network.sources[0].status, 'unavailable');
  assert.equal(network.sources[0].errorCode, 'request_failed');
  assert.doesNotMatch(JSON.stringify(network), /credentials|secret-token/);
  const redirect = await probeRelatedSources(queue, options(async (_url, init) => { assert.equal(init.redirect, 'error'); return new Response('', { status: 302, headers: { location: 'https://evil.example/' } }); }));
  assert.equal(redirect.sources[0].status, 'unavailable');
  assert.equal(redirect.sources[0].httpStatus, 302);
});

test('malformed JSON and wrong shape are invalid response, legitimate empty array is ok', async () => {
  for (const response of [() => new Response('{broken json'), () => Response.json({ items: null }), () => Response.json({ error: 'provider internal detail' })]) {
    const result = await probeRelatedSources(queue, options(async () => response()));
    assert.equal(result.sources[0].status, 'invalid_response');
    assert.doesNotMatch(JSON.stringify(result), /internal detail/);
  }
  const empty = await probeRelatedSources(queue, options(async () => Response.json({ items: [] })));
  assert.equal(empty.sources[0].status, 'ok');
  assert.equal(empty.sources[0].recordCount, 0);
});

test('response cap enforces both declared and streamed byte length before JSON decoding', async () => {
  const declared = await probeRelatedSources(queue, options(async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })));
  assert.equal(declared.sources[0].errorCode, 'response_too_large');
  const streamed = await probeRelatedSources(queue, options(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close(); } }))));
  assert.equal(streamed.sources[0].status, 'invalid_response');
  assert.equal(streamed.sources[0].errorCode, 'response_too_large');
});

test('15 second deadline includes stalled response body, not just response headers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelCalled = false;
  const pending = probeRelatedSources(queue, options(async () => new Response(new ReadableStream({ cancel() { cancelCalled = true; } }))));
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(15_000);
  const result = await pending;
  assert.equal(result.sources[0].status, 'unavailable');
  assert.equal(result.sources[0].errorCode, 'timeout');
  assert.equal(cancelCalled, true);
});

test('invalid queue is rejected before any network request', async () => {
  let called = false;
  await assert.rejects(probeRelatedSources({ ...queue, queueId: 'bad' }, options(async () => { called = true; })), /Invalid research queue/);
  assert.equal(called, false);
});
