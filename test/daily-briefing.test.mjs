import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dailyBriefing } from '../src/daily-briefing.js';

const dataDate = '2026-10-01';
const previousDate = '2026-09-30';
const article = (title, previousViews, views, patch = {}) => ({
  title, views,
  series: [{ date: previousDate, views: previousViews }, { date: dataDate, views }],
  ...patch,
});
const snapshot = (articles, patch = {}) => ({ dataDate, articles, ...patch });

test('ranks up to three observed changes by absolute daily difference, including decreases', () => {
  const result = dailyBriefing(snapshot([
    article('עלייה', 100, 300), article('ירידה', 1000, 500),
    article('קטנה', 1, 2), article('שלישית', 100, 150), article('ללא שינוי', 100, 100),
  ]));
  assert.deepEqual(result, {
    dataDate, previousDate, comparedCount: 5,
    insights: [
      { kind: 'decrease', title: 'ירידה', previousViews: 1000, views: 500, delta: -500, percentChange: -50 },
      { kind: 'increase', title: 'עלייה', previousViews: 100, views: 300, delta: 200, percentChange: 200 },
      { kind: 'increase', title: 'שלישית', previousViews: 100, views: 150, delta: 50, percentChange: 50 },
    ],
  });
});

test('partial baseline histories participate only with their own exact observed daily pair', () => {
  const result = dailyBriefing(snapshot([article('מלא', 100, 110)], {
    uncomparedArticles: [article('חלקי', 10, 60, { reason: 'incomplete_history', ratio: null })],
  }));
  assert.equal(result.comparedCount, 2);
  assert.equal(result.insights[0].title, 'חלקי');
  assert.equal(result.insights[0].delta, 50);
});

test('missing and unknown previous observations never become zero', () => {
  const result = dailyBriefing(snapshot([
    article('חסר', 100, 500, { series: [{ date: dataDate, views: 500 }] }),
    article('יום ישן', 100, 500, { series: [{ date: '2026-09-29', views: 100 }, { date: dataDate, views: 500 }] }),
    article('לא ידוע', null, 500), article('מוגדר', undefined, 500),
    article('אין היום', 100, 500, { series: [{ date: previousDate, views: 100 }] }),
  ]));
  assert.equal(result.comparedCount, 0);
  assert.deepEqual(result.insights, []);
});

test('measured zero is valid, but growth from zero has no percentage', () => {
  const result = dailyBriefing(snapshot([
    article('מאפס', 0, 10), article('לאפס', 5, 0), article('אפס קבוע', 0, 0),
  ]));
  assert.equal(result.comparedCount, 3);
  assert.equal(result.insights[0].percentChange, null);
  assert.equal(result.insights[0].delta, 10);
  assert.equal(result.insights[1].percentChange, -100);
  assert.equal(result.insights[1].views, 0);
  assert.equal(result.insights.length, 2);
});

test('uses snapshot dates rather than wall-clock today, including leap days and year boundaries', () => {
  for (const [day, previous] of [['2024-03-01', '2024-02-29'], ['2001-01-01', '2000-12-31'], [dataDate, previousDate]]) {
    const result = dailyBriefing({ dataDate: day, articles: [{ title: 'מדוד', views: 10, series: [{ date: previous, views: 5 }, { date: day, views: 10 }] }] });
    assert.equal(result.dataDate, day);
    assert.equal(result.previousDate, previous);
    assert.equal(result.comparedCount, 1);
    assert.equal(result.insights[0].delta, 5);
  }
});

test('invalid and impossible snapshot dates fail closed', () => {
  const empty = { dataDate: null, previousDate: null, comparedCount: 0, insights: [] };
  for (const value of [null, undefined, '', '2026-02-29', '2026-04-31', '2026-13-01', '2026-10-1', '2026-10-01T00:00:00Z']) {
    assert.deepEqual(dailyBriefing(snapshot([article('מדוד', 1, 2)], { dataDate: value })), empty);
  }
  assert.deepEqual(dailyBriefing(), empty);
});

test('malformed counts, series, or mismatched current totals exclude the article', () => {
  const records = [
    article('שונה', 1, 2, { views: 3 }), article('חסר סיכום', 1, 2, { views: null }),
    article('אין סדרה', 1, 2, { series: null }),
    ...[null, undefined, -1, 0.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1].map((value, index) => article(`פסול ${index}`, value, 2)),
    article('תאריך פסול', 1, 2, { series: [{ date: previousDate, views: 1 }, { date: dataDate, views: 2 }, { date: '2026-02-30', views: 3 }] }),
    article('תצפית פסולה', 1, 2, { series: [null] }),
  ];
  assert.equal(dailyBriefing(snapshot(records)).comparedCount, 0);
});

test('duplicate observations can agree, but conflicting observations exclude the article', () => {
  const consistent = article('זהה', 10, 20);
  consistent.series.push({ date: previousDate, views: 10 });
  assert.equal(dailyBriefing(snapshot([consistent])).comparedCount, 1);
  const conflict = article('סתירה', 10, 20);
  conflict.series.push({ date: previousDate, views: 99 });
  assert.equal(dailyBriefing(snapshot([conflict])).comparedCount, 0);
});

test('duplicate titles count once across groups and conflicting duplicates fail closed', () => {
  const full = article('שם_משותף', 10, 20);
  const partial = article('שם משותף', 10, 20);
  const result = dailyBriefing(snapshot([full], { uncomparedArticles: [partial] }));
  assert.equal(result.comparedCount, 1);
  assert.equal(result.insights.length, 1);
  assert.deepEqual(result, dailyBriefing(snapshot([partial], { uncomparedArticles: [full] })));
  assert.equal(dailyBriefing(snapshot([full, article('שם משותף', 1, 20)])).comparedCount, 0);
  assert.equal(dailyBriefing(snapshot([full, article('שם משותף', 10, 20, { series: [] })])).comparedCount, 0);
  const earlierConflict = article('שם משותף', 10, 20, { series: [...partial.series, { date: '2026-09-28', views: 9 }] });
  full.series.push({ date: '2026-09-28', views: 8 });
  assert.equal(dailyBriefing(snapshot([full, earlierConflict])).comparedCount, 0);
});

test('does not combine individually incomplete duplicate records into a fabricated daily pair', () => {
  const result = dailyBriefing(snapshot([
    article('חסר', 10, 20, { series: [{ date: previousDate, views: 10 }] }),
    article('חסר', 10, 20, { series: [{ date: dataDate, views: 20 }] }),
  ]));
  assert.equal(result.comparedCount, 0);
});

test('ties have deterministic title ordering independent of input and input stays unchanged', () => {
  const data = snapshot([article('ב', 20, 10), article('א', 10, 20)]);
  const before = structuredClone(data);
  const forward = dailyBriefing(data);
  assert.deepEqual(forward.insights.map(value => value.title), ['א', 'ב']);
  assert.deepEqual(forward, dailyBriefing(snapshot([...data.articles].reverse())));
  assert.deepEqual(data, before);
});

test('limit is bounded to three without changing eligible count, and all-unchanged data stays empty', () => {
  const data = snapshot([article('א', 1, 4), article('ב', 1, 3), article('ג', 1, 2), article('ד', 1, 5)]);
  for (const [limit, expected] of [[0, 0], [1, 1], [2, 2], [3, 3], [100, 3], [-1, 3], [1.5, 3], [NaN, 3], ['1', 3], [null, 3]]) {
    const result = dailyBriefing(data, { limit });
    assert.equal(result.insights.length, expected);
    assert.equal(result.comparedCount, 4);
  }
  assert.deepEqual(dailyBriefing(snapshot([article('זהה', 5, 5)])).insights, []);
  assert.deepEqual(dailyBriefing(snapshot(null)), { dataDate, previousDate, comparedCount: 0, insights: [] });
});

test('real fixture compares only observed day pairs and returns the true largest absolute differences', () => {
  const data = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url), 'utf8'));
  const result = dailyBriefing(data);
  const valid = [...data.articles, ...(data.uncomparedArticles ?? [])].flatMap(record => {
    const previous = record.series.find(point => point.date === result.previousDate);
    const current = record.series.find(point => point.date === data.dataDate);
    return previous && current && record.views === current.views ? [{ title: record.title, delta: current.views - previous.views }] : [];
  });
  const expected = valid.filter(record => record.delta).sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta)).slice(0, 3);
  assert.equal(result.comparedCount, valid.length);
  assert.deepEqual(result.insights.map(({ title, delta }) => ({ title, delta })), expected);
  assert.equal(result.insights.length, 3);
});
