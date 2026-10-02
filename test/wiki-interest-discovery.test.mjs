import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryMetric, selectDiscoveryArticles } from '../src/discovery-lib.js';

const full = (title, patch = {}) => ({ title, views: 100, ratio: 2, activeDays: 1, trend: 'rising', rank: 1, ...patch });
const partial = (title, patch = {}) => ({ title, views: 100, rank: 1, reason: 'incomplete_history', series: [], missingDates: [], ...patch });
const titles = articles => articles.map(article => article.title);
const snapshot = {
  articles: [
    full('השוואה_פופולרית', { views: 7430, ratio: 4, activeDays: 4, trend: 'sustained', rank: 2 }),
    full('השוואה_גבוהה', { views: 500, ratio: 10, activeDays: 1, rank: 5 }),
    full('השוואה_מתמשכת', { views: 600, ratio: 3, activeDays: 6, trend: 'sustained', rank: 4 }),
    full('השוואה_נמוכה', { views: 0, ratio: null, activeDays: null, trend: 'insufficient', rank: 6 }),
  ],
  uncomparedArticles: [
    partial('טיסה_1073', { views: 7494, rank: 1 }),
    partial('חלקי_אפס', { views: 0, rank: 3 }),
    partial('חלקי_לא_ידוע', { views: null, rank: 1 }),
  ],
};

test('popular ranks measured views across full and partial histories together', () => {
  const result = selectDiscoveryArticles(snapshot, 'popular');
  assert.equal(result.length, 7);
  assert.deepEqual(titles(result).slice(0, 2), ['טיסה_1073', 'השוואה_פופולרית']);
  assert.equal(result[0].views, 7494);
  assert.equal(result[0].comparisonAvailable, false);
  assert.equal(result[1].comparisonAvailable, true);
  assert.equal(result.at(-1).title, 'חלקי_לא_ידוע');
  assert.equal(result.at(-1).views, null);
  assert.ok(result.findIndex(article => article.title === 'חלקי_אפס') < result.length - 1);
});

test('surge without a query retains only full histories ordered by ratio', () => {
  const result = selectDiscoveryArticles(snapshot, 'surge');
  assert.deepEqual(titles(result), ['השוואה_גבוהה', 'השוואה_פופולרית', 'השוואה_מתמשכת', 'השוואה_נמוכה']);
  assert.ok(result.every(article => article.comparisonAvailable));
});

test('lasting without a query retains sustained full histories ordered by active days', () => {
  assert.deepEqual(titles(selectDiscoveryArticles(snapshot, 'lasting')), ['השוואה_מתמשכת', 'השוואה_פופולרית']);
  assert.deepEqual(titles(selectDiscoveryArticles(snapshot, 'lasting', '  ')), ['השוואה_מתמשכת', 'השוואה_פופולרית']);
});

test('search returns partial-only matches from every tab', () => {
  for (const sort of ['surge', 'popular', 'lasting']) {
    const result = selectDiscoveryArticles(snapshot, sort, 'טיסה 1073');
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'טיסה_1073');
    assert.equal(result[0].comparisonAvailable, false);
  }
});

test('search overrides the lasting filter and returns non-sustained full matches too', () => {
  const result = selectDiscoveryArticles(snapshot, 'lasting', 'השוואה');
  assert.deepEqual(titles(result), ['השוואה_מתמשכת', 'השוואה_פופולרית', 'השוואה_גבוהה', 'השוואה_נמוכה']);
});

test('search groups incomparable results after comparable matches for ratio and streak sorts', () => {
  const data = {
    articles: [full('בדיקה מלאה', { views: 1, ratio: 2, activeDays: 0 })],
    uncomparedArticles: [partial('בדיקה חלקית', { views: 1_000_000 }), partial('בדיקה חסרה', { views: null })],
  };
  for (const sort of ['surge', 'lasting']) {
    assert.deepEqual(titles(selectDiscoveryArticles(data, sort, 'בדיקה')), ['בדיקה מלאה', 'בדיקה חלקית', 'בדיקה חסרה']);
  }
  assert.deepEqual(titles(selectDiscoveryArticles(data, 'popular', 'בדיקה')), ['בדיקה חלקית', 'בדיקה מלאה', 'בדיקה חסרה']);
});

test('search treats query text literally and normalizes underscores, spaces, case and Unicode', () => {
  const data = { articles: [full('Topic_Name'), full('Café'), full('[בדיקה].*')] };
  assert.deepEqual(titles(selectDiscoveryArticles(data, 'surge', '  TOPIC_  name  ')), ['Topic_Name']);
  assert.deepEqual(titles(selectDiscoveryArticles(data, 'surge', 'Cafe\u0301')), ['Café']);
  assert.deepEqual(titles(selectDiscoveryArticles(data, 'surge', '[בדיקה].*')), ['[בדיקה].*']);
  assert.deepEqual(selectDiscoveryArticles(data, 'surge', '<script>'), []);
  assert.equal(selectDiscoveryArticles(data, 'surge', null).length, 3);
});

test('numeric ties use source rank then title and remain stable for exact ties', () => {
  const data = { articles: [
    full('ב', { rank: 2 }), full('ג', { rank: 1 }), full('א', { rank: 2 }),
    full('זהה', { rank: 3, marker: 'first' }), full('זהה', { rank: 3, marker: 'second' }),
  ] };
  assert.deepEqual(titles(selectDiscoveryArticles(data, 'popular')).slice(0, 3), ['ג', 'א', 'ב']);
  assert.deepEqual(selectDiscoveryArticles(data, 'popular').slice(-2).map(article => article.marker), ['first', 'second']);
});

test('selection neither mutates snapshot arrays nor adds metadata to stored articles', () => {
  const data = structuredClone(snapshot);
  const before = structuredClone(data);
  for (const record of [...data.articles, ...data.uncomparedArticles]) Object.freeze(record);
  Object.freeze(data.articles); Object.freeze(data.uncomparedArticles); Object.freeze(data);
  for (const sort of ['surge', 'popular', 'lasting']) selectDiscoveryArticles(data, sort, '');
  assert.deepEqual(data, before);
  assert.notEqual(selectDiscoveryArticles(data, 'popular')[0], data.uncomparedArticles[0]);
});

test('legacy snapshots, empty input and unknown sort remain predictable', () => {
  assert.deepEqual(selectDiscoveryArticles({ articles: [] }, 'popular'), []);
  assert.deepEqual(selectDiscoveryArticles(undefined), []);
  assert.deepEqual(selectDiscoveryArticles(snapshot, 'unknown'), selectDiscoveryArticles(snapshot, 'surge'));
});

test('primary metric matches the selected dimension, with distinct view and day labels', () => {
  const article = { ...snapshot.articles[0], comparisonAvailable: true };
  assert.deepEqual(discoveryMetric(article, 'surge'), { value: 'פי 4', label: 'מרמת הבסיס של הערך', secondary: '7,430 צפיות ביום המדידה' });
  assert.deepEqual(discoveryMetric(article, 'popular'), { value: '7,430', label: 'צפיות ביום המדידה', secondary: 'פי 4 מרמת הבסיס' });
  assert.deepEqual(discoveryMetric(article, 'lasting'), { value: '4', label: 'ימים רצופים של עניין מוגבר', secondary: '7,430 צפיות ביום המדידה' });
  assert.match(discoveryMetric({ ...article, activeDays: 1 }, 'lasting').label, /^יום רצוף/);
  assert.match(discoveryMetric({ ...article, activeDays: 0 }, 'lasting').label, /^ימים רצופים/);
});

test('partial metrics always use observed views, never ratio or streak fields', () => {
  const article = { ...partial('חלקי', { views: 7494 }), comparisonAvailable: false, ratio: 999, activeDays: 7 };
  for (const sort of ['surge', 'popular', 'lasting']) {
    assert.deepEqual(discoveryMetric(article, sort), { value: '7,494', label: 'צפיות ביום המדידה', secondary: 'בלי השוואת מגמה' });
  }
  assert.equal(discoveryMetric({ ...article, comparisonAvailable: true }, 'surge').value, '7,494', 'reason protects a raw partial record even if UI metadata is incorrect');
});

test('unknown views stay unknown while a measured zero remains zero in every mode', () => {
  for (const sort of ['surge', 'popular', 'lasting']) {
    assert.deepEqual(discoveryMetric(partial('חסר', { views: null }), sort), { value: '—', label: 'אין נתון ליום המדידה', secondary: 'בלי השוואת מגמה' });
    assert.deepEqual(discoveryMetric(partial('אפס', { views: 0 }), sort), { value: '0', label: 'צפיות ביום המדידה', secondary: 'בלי השוואת מגמה' });
  }
});

test('insufficient baseline does not fabricate a ratio or a zero-day streak', () => {
  const article = snapshot.articles[3];
  assert.equal(discoveryMetric(article, 'surge').value, 'ללא בסיס מספיק');
  assert.deepEqual(discoveryMetric(article, 'lasting'), { value: '—', label: 'אין בסיס לחישוב רצף', secondary: '0 צפיות ביום המדידה' });
  assert.equal(discoveryMetric(article, 'popular').value, '0');
  assert.equal(discoveryMetric(article, 'popular').secondary, 'אין בסיס מספיק להשוואה');
});
