import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { articleSeriesUrl, shiftDate } from '../data-lib.mjs';
import { validateSnapshot } from '../src/ui-lib.js';

const fixture = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
function sample() {
  const data = structuredClone(fixture);
  const title = 'ערך לבדיקה חלקית';
  data.articles = data.articles.slice(0, 3);
  data.coverage.candidateCount = 4;
  data.coverage.articleCount = 3;
  data.coverage.failures = [{ title, error: 'Incomplete 35-day series' }];
  const series = structuredClone(data.articles[0].series.slice(1));
  data.uncomparedArticles = [{
    title, url: `https://he.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    sourceUrl: articleSeriesUrl(title, data.dataDate), rank: 1,
    reason: 'incomplete_history', views: series.at(-1).views,
    series, missingDates: [data.seriesStart],
  }];
  return data;
}

test('legacy snapshots and additive partial histories both validate', () => {
  const legacy = structuredClone(fixture); delete legacy.uncomparedArticles;
  assert.equal(validateSnapshot(legacy), legacy);
  const data = sample();
  assert.equal(validateSnapshot(data), data);
});

test('missing latest data is null; a measured zero stays zero', () => {
  const data = sample(), article = data.uncomparedArticles[0];
  article.series.at(-1).views = 0; article.views = 0;
  assert.equal(validateSnapshot(data), data);
  article.series.pop(); article.views = null; article.missingDates.push(data.dataDate);
  assert.equal(validateSnapshot(data), data);
  article.views = 0;
  assert.throws(() => validateSnapshot(data), /partial latest/);
});

test('partial timelines, provenance, coverage and absence of comparison metrics are gated', () => {
  const mutations = [
    d => d.uncomparedArticles = null,
    d => d.uncomparedArticles.push(structuredClone(d.uncomparedArticles[0])),
    d => d.uncomparedArticles[0].title = d.articles[0].title,
    d => d.uncomparedArticles[0].reason = 'new_article',
    d => d.uncomparedArticles[0].views++,
    d => d.uncomparedArticles[0].series[0].views = -1,
    d => d.uncomparedArticles[0].series[0].views = 0.5,
    d => d.uncomparedArticles[0].series[0].views = Number.MAX_SAFE_INTEGER + 1,
    d => d.uncomparedArticles[0].series[0].date = shiftDate(d.seriesStart, -1),
    d => d.uncomparedArticles[0].series.at(-1).date = shiftDate(d.dataDate, 1),
    d => d.uncomparedArticles[0].series.reverse(),
    d => d.uncomparedArticles[0].series[1].date = d.uncomparedArticles[0].series[0].date,
    d => d.uncomparedArticles[0].series = [],
    d => d.uncomparedArticles[0].series = d.articles[0].series,
    d => d.uncomparedArticles[0].missingDates = [],
    d => d.uncomparedArticles[0].missingDates.push(d.seriesStart),
    d => d.uncomparedArticles[0].rank = 0,
    d => d.uncomparedArticles[0].rank = d.coverage.topListCount + 1,
    d => d.uncomparedArticles[0].url = 'javascript:alert(1)',
    d => d.uncomparedArticles[0].url = d.articles[0].url,
    d => d.uncomparedArticles[0].sourceUrl = d.uncomparedArticles[0].sourceUrl.replace('/user/', '/all-agents/'),
    d => d.coverage.failures[0].error = 'HTTP 503',
    ...['baseline', 'ratio', 'excess', 'activeDays', 'trend'].map(key => d => d.uncomparedArticles[0][key] = null),
  ];
  for (const mutate of mutations) {
    const data = sample(); mutate(data);
    assert.throws(() => validateSnapshot(data), undefined, mutate.toString());
  }
});
