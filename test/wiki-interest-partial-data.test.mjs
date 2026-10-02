import test from 'node:test';
import assert from 'node:assert/strict';
import { articleSeriesUrl, buildArticle, buildUncomparedArticle, parseDailySeries, shiftDate, windowFor } from '../data-lib.mjs';
import { collectSnapshot } from '../collect.mjs';

const dataDate = '2026-10-01';
const candidate = { article: 'ערך_חלקי', rank: 4, views: 999_999 };
const quiet = { log() {}, warn() {} };
const now = () => new Date('2026-10-02T12:00:00Z');
const itemsFor = () => Array.from({ length: 35 }, (_, index) => ({
  timestamp: `${shiftDate(windowFor(dataDate).seriesStart, index).replaceAll('-', '')}00`,
  views: index === 34 ? 220 : 100,
}));
const comparableCandidates = Array.from({ length: 3 }, (_, index) => ({ article: `מלא_${index + 1}`, rank: index + 1 }));

async function collectWithLast(lastResponse, { candidates = [...comparableCandidates, candidate] } = {}) {
  return collectSnapshot({
    requestedDate: dataDate, maxFallbackDays: 0, logger: quiet, now, waitImpl: async () => {},
    fetchImpl: async url => {
      if (url.includes('/top/')) return Response.json({ items: [{ year: '2026', month: '10', day: '01', articles: candidates }] });
      if (url === articleSeriesUrl(candidate.article, dataDate)) return lastResponse();
      assert.ok(candidates.some(value => articleSeriesUrl(value.article, dataDate) === url), 'unexpected source request');
      return Response.json({ items: itemsFor() });
    },
  });
}

test('partial histories preserve observed zero and sorted gaps without comparison metrics', () => {
  const items = itemsFor().filter((_, index) => index !== 2 && index !== 30);
  items[0].views = 0;
  items.at(-1).views = 0;
  const result = buildUncomparedArticle(candidate, items.reverse(), dataDate);
  assert.equal(result.title, 'ערך חלקי');
  assert.equal(result.reason, 'incomplete_history');
  assert.equal(result.rank, 4);
  assert.equal(result.views, 0, 'latest observed zero is not replaced by a top-list count');
  assert.equal(result.series[0].views, 0);
  assert.equal(result.series.length, 33);
  assert.equal(result.series.at(-1).date, dataDate);
  assert.deepEqual(result.missingDates, ['2026-08-30', '2026-09-27']);
  assert.equal(result.sourceUrl, articleSeriesUrl(candidate.article, dataDate));
  assert.equal(result.url, `https://he.wikipedia.org/wiki/${encodeURIComponent(candidate.article)}`);
  for (const key of ['baseline', 'ratio', 'excess', 'activeDays', 'trend']) assert.equal(Object.hasOwn(result, key), false);
  assert.equal(result.series.some(point => result.missingDates.includes(point.date)), false);
  assert.throws(() => buildArticle(candidate, items, dataDate), error => error.code === 'INCOMPLETE_HISTORY');
});

test('missing final date means unknown views, not the previous day or top-list volume', () => {
  const items = itemsFor().slice(0, -1);
  const result = buildUncomparedArticle(candidate, items, dataDate);
  assert.equal(result.views, null);
  assert.deepEqual(result.missingDates, [dataDate]);
  assert.equal(result.series.at(-1).date, '2026-09-30');
  assert.equal(result.series.at(-1).views, 100);
});

test('a single measured day remains a single day and has all other dates explicitly missing', () => {
  const result = buildUncomparedArticle(candidate, [itemsFor().at(-1)], dataDate);
  assert.deepEqual(result.series, [{ date: dataDate, views: 220 }]);
  assert.equal(result.missingDates.length, 34);
  assert.equal(result.missingDates[0], '2026-08-28');
  assert.equal(result.missingDates.at(-1), '2026-09-30');
});

test('complete low-baseline histories are not misclassified as incomplete', () => {
  const items = itemsFor().map(item => ({ ...item, views: 0 }));
  const article = buildArticle(candidate, items, dataDate);
  assert.equal(article.trend, 'insufficient');
  assert.equal(article.baseline, 0);
  assert.deepEqual(parseDailySeries(items, dataDate).missingDates, []);
  assert.throws(() => buildUncomparedArticle(candidate, items, dataDate), /Expected incomplete/);
});

test('duplicates, invalid dates/counts, hours, empty and out-of-window observations cannot become partial cards', () => {
  const valid = itemsFor().slice(1);
  const malformed = [
    [...valid, valid[0]],
    [...valid, { timestamp: '2026023000', views: 1 }],
    [...valid, { timestamp: '2026100200', views: 1 }],
    [...valid, { timestamp: '2026082700', views: 1 }],
    [{ timestamp: '2026100112', views: 1 }],
    [{ timestamp: {}, views: 1 }],
    [{ timestamp: '2026100100', views: -1 }],
    [{ timestamp: '2026100100', views: 1.5 }],
    [{ timestamp: '2026100100', views: Number.MAX_SAFE_INTEGER + 1 }],
    [{ timestamp: '2026100100', views: '1' }],
    [{ timestamp: '2026100100', views: Number.NaN }],
    [null], [[]], [], null, {},
  ];
  for (const items of malformed) {
    assert.throws(() => buildUncomparedArticle(candidate, items, dataDate));
    assert.throws(() => buildArticle(candidate, items, dataDate), error => error.code !== 'INCOMPLETE_HISTORY');
  }
});

test('collector includes validated partial histories while preserving the comparison failure contract', async () => {
  const items = itemsFor().slice(1);
  const snapshot = await collectWithLast(() => Response.json({ items }));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.articles.length, 3);
  assert.equal(snapshot.coverage.articleCount, 3);
  assert.equal(snapshot.coverage.candidateCount, 4);
  assert.deepEqual(snapshot.coverage.failures, [{ title: 'ערך חלקי', error: 'Incomplete 35-day series' }]);
  assert.deepEqual(snapshot.uncomparedArticles, [buildUncomparedArticle(candidate, items, dataDate)]);
  assert.match(snapshot.method.missingData, /without baseline, ratio, trend or streak metrics/);
});

test('collector always emits an uncompared array including when all histories are complete', async () => {
  const snapshot = await collectWithLast(() => Response.json({ items: itemsFor() }));
  assert.deepEqual(snapshot.uncomparedArticles, []);
  assert.deepEqual(snapshot.coverage.failures, []);
  assert.equal(snapshot.articles.length, 4);
});

test('collector does not manufacture partial cards for malformed, empty or unavailable responses', async () => {
  const responses = [
    () => Response.json({ items: [] }),
    () => Response.json({}),
    () => Response.json({ items: [...itemsFor().slice(1), itemsFor()[1]] }),
    () => Response.json({ items: [{ timestamp: '2026100100', views: -1 }] }),
    () => Response.json({ items: [{ timestamp: '2026100200', views: 10 }] }),
    () => new Response('', { status: 404 }),
    () => { throw new Error('Untrusted network diagnostic https://secret.invalid/credential'); },
  ];
  for (const response of responses) {
    const snapshot = await collectWithLast(response);
    assert.deepEqual(snapshot.uncomparedArticles, []);
    assert.equal(snapshot.coverage.failures.length, 1);
    assert.notEqual(snapshot.coverage.failures[0].error, 'Incomplete 35-day series');
    assert.doesNotMatch(snapshot.coverage.failures[0].error, /secret|credential|network diagnostic/);
  }
});

test('uncompared histories do not relax the 75 percent complete-history publishing gate', async () => {
  const candidates = [comparableCandidates[0], comparableCandidates[1], candidate];
  await assert.rejects(collectWithLast(() => Response.json({ items: itemsFor().slice(1) }), { candidates }), error => error.code === 'PARTIAL_DATA');
});
