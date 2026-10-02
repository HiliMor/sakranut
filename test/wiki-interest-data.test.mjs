import test from 'node:test';
import assert from 'node:assert/strict';
import { articleSeriesUrl, buildArticle, calculateMetrics, isEligibleTitle, median, normalizeSeries, parseDate, retryDelayMs, selectCandidates, shiftDate, topUrl, windowFor } from '../data-lib.mjs';

const exampleSeries = (baseline = 100, lastSeven = Array(7).fill(100)) =>
  [...Array(28).fill(baseline), ...lastSeven].map((views, index) => ({ date: shiftDate('2026-08-28', index), views }));
const apiItems = series => series.map(day => ({ timestamp: `${day.date.replaceAll('-', '')}00`, views: day.views }));

test('Retry-After honors seconds and HTTP dates without shortening publisher delay', () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  assert.equal(retryDelayMs('45', { now }), 45_000);
  assert.equal(retryDelayMs('60', { now }), 60_000);
  assert.equal(retryDelayMs('Fri, 02 Oct 2026 10:00:30 GMT', { now }), 30_000);
  assert.equal(retryDelayMs('Fri, 02 Oct 2026 09:59:30 GMT', { now }), 1_000);
  assert.equal(retryDelayMs(null, { now, attempt: 1 }), 2_000);
  assert.equal(retryDelayMs('invalid header', { now, attempt: 1 }), 2_000);
  assert.throws(() => retryDelayMs('61', { now }), error => error.code === 'STOP_COLLECTION');
  assert.throws(() => retryDelayMs('Fri, 02 Oct 2026 10:02:00 GMT', { now }), error => error.code === 'STOP_COLLECTION');
});

test('strict calendar dates and a 28+7 window across month boundary', () => {
  assert.throws(() => parseDate('2026-02-30'));
  assert.throws(() => parseDate('2026-2-01'));
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(windowFor('2026-10-01'), { seriesStart: '2026-08-28', baselineStart: '2026-08-28', baselineEnd: '2026-09-24', displayStart: '2026-09-25' });
});

test('median is not distorted by a single high day or by current week', () => {
  assert.equal(median([3, 1, 8, 2]), 2.5);
  const series = exampleSeries(100, Array(7).fill(10_000));
  series[2].views = 100_000;
  assert.equal(calculateMetrics(series).baseline, 100);
  assert.equal(calculateMetrics(series).ratio, 100);
  assert.equal(calculateMetrics(series).activeDays, 7);
});

test('explicit zero is valid, missing and duplicate days fail instead of imputing', () => {
  const items = apiItems(exampleSeries());
  items[0].views = 0;
  assert.equal(normalizeSeries(items.reverse(), '2026-10-01')[0].views, 0);
  assert.throws(() => normalizeSeries(items.slice(1), '2026-10-01'), /Missing daily/);
  assert.throws(() => normalizeSeries([...items, items[0]], '2026-10-01'), /Duplicate/);
  assert.throws(() => normalizeSeries([{ timestamp: '2026100100', views: -1 }], '2026-10-01'), /Invalid views/);
  assert.throws(() => normalizeSeries([{ timestamp: '2026100101', views: 10 }], '2026-10-01'), /Invalid daily timestamp/);
  assert.throws(() => normalizeSeries([...items, { timestamp: '2026082700', views: 10 }], '2026-10-01'), /outside requested window/);
});

test('small baselines never create exaggerated ratios or invented streaks', () => {
  for (const baseline of [0, 1, 19]) {
    const result = calculateMetrics(exampleSeries(baseline, Array(7).fill(1000)));
    assert.equal(result.ratio, null);
    assert.equal(result.activeDays, null);
    assert.equal(result.trend, 'insufficient');
  }
  assert.equal(calculateMetrics(exampleSeries(20, Array(7).fill(100))).ratio, 5);
});

test('elevation requires both volume and ratio; days are consecutive ending now', () => {
  assert.equal(calculateMetrics(exampleSeries(20, Array(7).fill(99))).activeDays, 0);
  assert.equal(calculateMetrics(exampleSeries(100, [300, 300, 100, 300, 300, 300, 300])).activeDays, 4);
  assert.equal(calculateMetrics(exampleSeries(100, [100, 100, 100, 100, 100, 200, 200])).activeDays, 2);
});

test('transparent trend rule ordering includes cooling despite elevated today', () => {
  assert.equal(calculateMetrics(exampleSeries(100, [100, 100, 100, 100, 100, 100, 220])).trend, 'rising');
  assert.equal(calculateMetrics(exampleSeries(100, [100, 100, 100, 100, 220, 230, 240])).trend, 'sustained');
  assert.equal(calculateMetrics(exampleSeries(100, [100, 1000, 1000, 900, 700, 500, 400])).trend, 'cooling');
  assert.equal(calculateMetrics(exampleSeries()).trend, 'steady');
  assert.throws(() => calculateMetrics([]), /35/);
});

test('candidate filtering retains rank, excludes namespaces and duplicate titles', () => {
  assert.equal(isEligibleTitle('עמוד_ראשי'), false);
  assert.equal(isEligibleTitle('ויקיפדיה:מזנון'), false);
  assert.equal(isEligibleTitle('ערך:עם_נקודתיים'), false);
  const candidates = selectCandidates([{ article: 'עמוד_ראשי', rank: 1 }, { article: 'ישראל', rank: 2 }, { article: 'ישראל', rank: 3 }, { article: 'סוכות', rank: 4 }], 1);
  assert.deepEqual(candidates, [{ article: 'ישראל', rank: 2 }]);
});

test('source links are exact, escaped and metrics use per-article user counts', () => {
  assert.equal(topUrl('2026-10-01'), 'https://wikimedia.org/api/rest_v1/metrics/pageviews/top/he.wikipedia.org/all-access/2026/10/01');
  const result = buildArticle({ article: 'שמחת_תורה', rank: 8, views: 5000 }, apiItems(exampleSeries()), '2026-10-01');
  assert.equal(result.title, 'שמחת תורה');
  assert.equal(result.views, 100);
  assert.equal(result.rank, 8);
  assert.equal(result.sourceUrl, articleSeriesUrl('שמחת_תורה', '2026-10-01'));
  assert.match(result.sourceUrl, /\/user\//);
  assert.match(result.sourceUrl, /\/2026082800\/2026100100$/);
  assert.equal(new URL(result.url).hostname, 'he.wikipedia.org');
});
