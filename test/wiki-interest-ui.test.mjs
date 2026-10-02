import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSnapshot, selectArticles, chartMarkup, escapeHtml, number, ratioLabel } from '../src/ui-lib.js';
import { articleSeriesUrl, calculateMetrics, shiftDate } from '../data-lib.mjs';

const snapshot = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
test('real Wikimedia snapshot including null-baseline metrics passes UI validation', () => {
  assert.equal(validateSnapshot(snapshot), snapshot);
  assert(snapshot.articles.some(a => a.activeDays === null));
});
test('mismatched timeline, baseline, ratio, invalid dates fail closed', () => {
  for (const mutate of [
    d => d.articles[0].series.pop(),
    d => d.articles[0].series[3].date = d.articles[0].series[2].date,
    d => d.articles[0].baseline++,
    d => d.articles[0].ratio++,
    d => d.dataDate = '2026-02-30',
    d => d.seriesStart = '2026-01-01',
    d => d.articles.push(d.articles[0]),
    d => d.articles.find(a => a.ratio === null).ratio = 1,
  ]) { const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => validateSnapshot(copy)); }
});
test('derived trend, consecutive days, excess and safe-integer counts are verified', () => {
  for (const mutate of [
    d => d.articles[0].trend = 'sustained',
    d => d.articles[0].activeDays = 7,
    d => d.articles[0].excess++,
    d => d.articles[0].series[0].views += .5,
    d => d.articles[0].series[0].views = Number.MAX_SAFE_INTEGER + 1,
    d => d.articles[0].views += .5,
    d => d.articles[0].rank = 1.5,
    d => d.articles[0].rank = d.coverage.topListCount + 1,
    d => d.articles[0].series[0] = null,
    d => d.articles.find(a => a.activeDays === null).activeDays = 0,
  ]) { const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => validateSnapshot(copy)); }
});
test('all metric classes validate when recomputed from complete measured series', () => {
  const cases = [
    { baseline: 10, last: [10,10,10,10,10,10,500], expected: 'insufficient' },
    { baseline: 50, last: [50,50,50,50,50,50,200], expected: 'rising' },
    { baseline: 50, last: [50,50,50,200,200,200,200], expected: 'sustained' },
    { baseline: 50, last: [50,50,50,1000,200,200,200], expected: 'cooling' },
    { baseline: 50, last: [50,50,50,50,50,50,50], expected: 'steady' },
  ];
  for (const { baseline, last, expected } of cases) {
    const copy = structuredClone(snapshot);
    const article = copy.articles[0];
    article.series = article.series.map((point, index) => ({ ...point, views: index < 28 ? baseline : last[index - 28] }));
    Object.assign(article, calculateMetrics(article.series));
    assert.equal(article.trend, expected);
    assert.equal(validateSnapshot(copy), copy);
  }
});
test('source, method and coverage metadata are required and internally consistent', () => {
  for (const mutate of [
    d => delete d.source,
    d => delete d.method,
    d => delete d.coverage,
    d => d.source.name = 'Different provider',
    d => d.source.license = 'All rights reserved',
    d => d.method.project = 'en.wikipedia.org',
    d => d.method.agent = 'all-agents',
    d => d.method.access = 'desktop',
    d => d.method.baselineDays = 14,
    d => d.method.displayDays = 14,
    d => d.method.minimumBaseline = 1,
    d => d.method.timezone = 'Asia/Jerusalem',
    d => delete d.method.baseline,
    d => d.method.limitations = [],
    d => delete d.method.trends.cooling,
    d => d.coverage.articleCount++,
    d => d.coverage.candidateCount = 31,
    d => d.coverage.topListCount = 5,
    d => d.coverage.fallbackDays = 1,
    d => d.coverage.requestedDate = '2026-02-30',
    d => d.coverage.failures.pop(),
    d => d.coverage.failures[0].title = d.articles[0].title,
    d => d.coverage.failures[0].error = '',
    d => { d.articles.splice(0, 2); d.coverage.articleCount = d.articles.length; d.coverage.failures.push({title:'omitted1',error:'Incomplete series'}, {title:'omitted2',error:'Incomplete series'}); },
    d => d.generatedAt = `${d.dataDate}T23:00:00Z`,
  ]) { const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => validateSnapshot(copy)); }
});
test('manual fallback dates and updated explanatory wording remain compatible', () => {
  const copy = structuredClone(snapshot);
  copy.coverage.requestedDate = shiftDate(copy.dataDate, 2);
  copy.coverage.fallbackDays = 2;
  copy.generatedAt = `${shiftDate(copy.dataDate, 3)}T12:00:00.000Z`;
  copy.method.limitations[copy.method.limitations.length - 1] = 'Daily scheduled snapshots, not realtime.';
  assert.equal(validateSnapshot(copy), copy);
});
test('links are HTTPS approved hosts and match the measured article, agent and dates', () => {
  for (const mutate of [
    d => d.articles[0].url = 'javascript:alert(1)',
    d => d.articles[0].url = d.articles[0].url.replace('https:', 'http:'),
    d => d.articles[0].url = d.articles[0].url.replace('he.wikipedia.org', 'he.wikipedia.org.evil.example'),
    d => d.articles[0].url = d.articles[0].url.replace('https://', 'https://user:password@'),
    d => d.articles[0].url += '?redirect=elsewhere',
    d => d.articles[0].url = d.articles[1].url,
    d => d.articles[0].sourceUrl = d.articles[0].sourceUrl.replace('/user/', '/all-agents/'),
    d => d.articles[0].sourceUrl = articleSeriesUrl(d.articles[0].title, shiftDate(d.dataDate, -1)),
    d => d.articles[0].sourceUrl = d.articles[1].sourceUrl,
    d => d.source.url = 'https://wikimedia.org.evil.example/reference',
    d => d.source.policyUrl = 'http://doc.wikimedia.org/policy',
    d => d.source.licenseUrl = 'https://creativecommons.org/licenses/by/4.0/',
    d => d.source.topUrl += '?otherDate=2026-01-01',
    d => d.source.topUrl = d.source.topUrl.replace('/2026/10/01', '/2026/09/30'),
  ]) { const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => validateSnapshot(copy)); }
  const copy = structuredClone(snapshot);
  copy.articles[0].url = `https://he.wikipedia.org/wiki/${encodeURIComponent(copy.articles[0].title)}`;
  copy.articles[0].sourceUrl = articleSeriesUrl(copy.articles[0].title, copy.dataDate);
  assert.equal(validateSnapshot(copy), copy);
});
test('discovery sorting is non-mutating, search scoped, persistence does not include cooling', () => {
  const before = snapshot.articles.map(a=>a.title);
  const surge = selectArticles(snapshot.articles);
  assert(surge[0].ratio >= surge[1].ratio);
  assert.equal(surge.at(-1).ratio, null);
  assert(selectArticles(snapshot.articles,'lasting').every(a=>a.trend === 'sustained' && a.activeDays >= 3));
  assert(selectArticles(snapshot.articles,'popular').every((a,i,all)=>i === 0 || a.views <= all[i-1].views));
  assert.equal(selectArticles(snapshot.articles,'surge','  עומאן ').length,1);
  assert.equal(selectArticles(snapshot.articles,'surge','not a title').length,0);
  assert.deepEqual(snapshot.articles.map(a=>a.title),before);
});
test('fractional medians are preserved and insufficient baseline is not zero or infinity', () => {
  assert.equal(number(45.5),'45.5');
  assert.equal(number(20695),'20,695');
  assert.equal(ratioLabel(null),'ללא בסיס מספיק');
});
test('full chart axis labels remain HTML text rather than shrinking inside the SVG', () => {
  const markup = chartMarkup(snapshot.articles[0]);
  assert.match(markup, /^<div class="chart-frame" role="img" aria-label=/);
  assert.match(markup, /טבלת 14 הימים זמינה/);
  assert.match(markup, /<div class="chart-y-axis" aria-hidden="true"><span>/);
  assert.equal((markup.match(/class="chart-gridline"/g) || []).length, 3);
  assert.doesNotMatch(markup, /<text\b|font-size=/);
  assert.match(markup, /<svg[^>]*preserveAspectRatio="none"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  const path = markup.match(/class="chart-path" d="([^"]+)"/)[1];
  assert.equal((path.match(/[ML]/g) || []).length, 14);
});

test('compact chart is decorative and low-count axes keep distinct finite tick values', () => {
  const compact = chartMarkup(snapshot.articles[0], true);
  assert.match(compact, /^<svg class="sparkline"/);
  assert.match(compact, /aria-hidden="true" focusable="false"/);
  assert.doesNotMatch(compact, /chart-y-axis|role="img"|aria-label=/);
  const zero = { ...snapshot.articles[0], baseline: 0, series: snapshot.articles[0].series.map(point => ({ ...point, views: 0 })) };
  const markup = chartMarkup(zero);
  assert.match(markup, /<span>1\.1<\/span><span>0\.6<\/span><span>0<\/span>/);
  assert.doesNotMatch(markup, /NaN|Infinity/);
});

test('chart presentation leaves the measured series, baseline and metrics unchanged', () => {
  const article = structuredClone(snapshot.articles[0]);
  const original = structuredClone(article);
  chartMarkup(article);
  chartMarkup(article, true);
  assert.deepEqual(article, original);
});

test('chart is finite even for zero series and titles cannot inject markup', () => {
  const article = {...snapshot.articles[0], title:'<script>alert(1)</script>', baseline:0, series:snapshot.articles[0].series.map(p=>({...p,views:0}))};
  const markup = chartMarkup(article);
  assert(!markup.includes('NaN'));
  assert(!markup.includes('Infinity'));
  assert(!markup.includes('<script>'));
  assert(markup.includes('role="img"'));
  assert.equal(escapeHtml('"<&'),'&quot;&lt;&amp;');
});
