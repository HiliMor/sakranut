import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildArticle, shiftDate } from '../data-lib.mjs';
import { buildResearchQueue } from '../src/context-pilot-lib.js';
import { normalizeText, matchRelatedCoverage } from '../src/related-coverage-lib.js';

const fixture = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
function queueFor(titles = ['יעקב עמידרור', 'תעתוע (סרט)', 'סאמי אבו שחאדה', 'Another Topic', 'כותרת כבויה']) {
  const snapshot = structuredClone(fixture);
  snapshot.articles = titles.map((title, index) => buildArticle({ article: title, rank: index + 1 }, Array.from({ length: 35 }, (_, day) => ({
    timestamp: `${shiftDate(snapshot.seriesStart, day).replaceAll('-', '')}00`, views: day === 34 ? 1000 : 100,
  })), snapshot.dataDate));
  snapshot.uncomparedArticles = [];
  snapshot.coverage = { ...snapshot.coverage, topListCount: titles.length, candidateCount: titles.length, articleCount: titles.length, failures: [] };
  return buildResearchQueue(snapshot);
}
const queue = queueFor();
const record = (id, title = 'יעקב עמידרור התראיין', patch = {}) => ({ id, sourceId: 'news-a', title,
  url: `https://news.example.org/story/${id}`, publishedDate: queue.dataDate, observedAt: `${shiftDate(queue.dataDate, 1)}T12:00:00Z`, ...patch });
const itemFor = (result, title = 'יעקב עמידרור') => result.items.find(item => item.title === title);
const filmRules = { 'תעתוע (סרט)': { aliases: ['תעתוע'], requiredAny: ['סרט', 'קולנוע', 'וריטי', 'בלייק'] } };

test('normalization handles Hebrew niqqud, punctuation, hyphens and case without stemming', () => {
  assert.equal(normalizeText('  יַעֲקֹב — עֲמִידְרוֹר!  '), 'יעקב עמידרור');
  assert.equal(normalizeText('סאמי־אבו-שחאדה'), 'סאמי אבו שחאדה');
  assert.equal(normalizeText('ANOTHER_Topic Café'), 'another topic cafe');
  assert.equal(normalizeText('צה״ל'), 'צהל');
  assert.equal(normalizeText(null), '');
});

test('default matching requires the full entity phrase with token boundaries, never a surname alone', () => {
  const result = matchRelatedCoverage(queue, [record('yes', 'יַעֲקֹב־עמידרור התראיין'), record('surname', 'עמידרור התראיין'),
    record('prefix', 'ליעקב עמידרור נאמר'), record('suffix', 'יעקב עמידרוריות'), record('other-person', 'אריה עמידרור התראיין')]);
  assert.deepEqual(itemFor(result).links.map(link => link.recordId), ['yes']);
  assert.ok(itemFor(result).rejections.every(rejection => rejection.reason === 'no_entity_match'));
  assert.throws(() => matchRelatedCoverage(queue, [], { 'יעקב עמידרור': { aliases: ['עמידרור'] } }), /disambiguation/);
});

test('a phrase cannot be stitched across title and snippet, while metadata-only matches are explicit', () => {
  const result = matchRelatedCoverage(queue, [record('split', 'יעקב', { text: 'עמידרור התראיין' }),
    record('snippet', 'ראיון חדש', { text: 'המרואיין יעקב עמידרור הציג את עמדתו.' })]);
  assert.deepEqual(itemFor(result).links.map(link => link.recordId), ['snippet']);
  assert.equal(itemFor(result).links[0].matchedField, 'text');
  assert.equal(result.evidenceBasis, 'metadata-only');
  assert.equal(Object.hasOwn(itemFor(result).links[0], 'text'), false);
});

test('ambiguous film alias needs an explicit contextual term with its own token boundary', () => {
  const result = matchRelatedCoverage(queue, [record('film', 'תעתוע מגיע לקולנוע', { text: 'סרט עם בלייק' }),
    record('word', 'תעתוע מעניין בשוק ההון'), record('substring', 'תעתוע וסרטונים'), record('not-alias', 'תעתועים בקולנוע')], filmRules);
  const film = itemFor(result, 'תעתוע (סרט)');
  assert.deepEqual(film.links.map(link => link.recordId), ['film']);
  assert.equal(film.links[0].matchedAlias, 'תעתוע');
  assert.ok(['בלייק', 'סרט'].includes(film.links[0].matchedRequiredTerm));
  assert.equal(film.rejections.filter(rejection => rejection.reason === 'ambiguous_entity').length, 2);
  assert.equal(film.rejections.find(rejection => rejection.recordId === 'not-alias').reason, 'no_entity_match');
});

test('dates must be known and valid within the inclusive queue window; observed time is not a publication date', () => {
  const result = matchRelatedCoverage(queue, [record('first', 'יעקב עמידרור בגבול החלון', { publishedDate: shiftDate(queue.dataDate, -2) }),
    record('last', 'יעקב עמידרור ביום המדידה'), record('unknown', undefined, { publishedDate: null }),
    record('missing', undefined, { publishedDate: undefined }), record('bad', undefined, { publishedDate: '2026-02-30' }),
    record('old', undefined, { publishedDate: shiftDate(queue.dataDate, -3) }), record('future', undefined, { publishedDate: shiftDate(queue.dataDate, 1) })]);
  const item = itemFor(result);
  assert.deepEqual(item.links.map(link => link.recordId), ['last', 'first']);
  assert.deepEqual(Object.fromEntries(item.rejections.map(rejection => [rejection.recordId, rejection.reason])), {
    future: 'future_date', old: 'outside_window', bad: 'invalid_date', missing: 'unknown_date', unknown: 'unknown_date',
  });
});

test('tracking parameters and fragments are stripped while content-identifying query parameters stay', () => {
  const result = matchRelatedCoverage(queue, [
    record('a', 'יעקב עמידרור דיווח ראשון', { url: 'https://news.example.org/story?id=17&utm_source=x&fbclid=tracking#top' }),
    record('b', 'יעקב עמידרור דיווח מעודכן', { url: 'https://news.example.org/story?gclid=tracking&id=17' }),
    record('c', 'יעקב עמידרור דיווח נפרד', { url: 'https://news.example.org/story?id=18&utm_campaign=x' }),
  ]);
  const item = itemFor(result);
  assert.deepEqual(item.links.map(link => link.url), ['https://news.example.org/story?id=17', 'https://news.example.org/story?id=18']);
  assert.equal(item.rejections.filter(rejection => rejection.reason === 'duplicate_url').length, 1);
});

test('normalized duplicate titles are not counted as independent links, even across sources', () => {
  const result = matchRelatedCoverage(queue, [record('a', 'יעקב—עמידרור: ראיון'), record('b', 'יַעֲקֹב עמידרור ראיון', { sourceId: 'news-b' })]);
  assert.equal(itemFor(result).links.length, 1);
  assert.equal(itemFor(result).rejections[0].reason, 'duplicate_title');
  const sameIdentity = [record(undefined, 'יעקב—עמידרור: ראיון', { url: 'https://news.example.org/same' }),
    record(undefined, 'יַעֲקֹב עמידרור ראיון', { url: 'https://news.example.org/same' })];
  assert.deepEqual(matchRelatedCoverage(queue, sameIdentity), matchRelatedCoverage(queue, [...sameIdentity].reverse()));
});

test('links cap at three, sorting and rejection outcomes are stable regardless of input ordering', () => {
  const records = [1, 2, 3, 4, 5].map(index => record(index, `יעקב עמידרור ידיעה ${index}`, { publishedDate: shiftDate(queue.dataDate, index % 2 ? 0 : -1) }));
  const first = matchRelatedCoverage(queue, records), reversed = matchRelatedCoverage(queue, [...records].reverse());
  assert.deepEqual(first, reversed);
  assert.deepEqual(itemFor(first).links.map(link => link.recordId), ['1', '3', '5']);
  assert.equal(itemFor(first).rejections.filter(rejection => rejection.reason === 'link_limit').length, 2);
});

test('unsafe URLs and malformed metadata fail closed without retaining navigable rejected URLs', () => {
  const result = matchRelatedCoverage(queue, [record('http', undefined, { url: 'http://news.example.org/story' }),
    record('credentials', undefined, { url: 'https://user:secret@news.example.org/story' }),
    record('internal', undefined, { url: 'https://10.0.0.1/story' }), record('local', undefined, { url: 'https://server.internal/story' }),
    record('body', undefined, { text: 'x'.repeat(1201) }), record('source', undefined, { sourceId: null }), null]);
  assert.equal(itemFor(result).links.length, 0);
  assert.equal(itemFor(result).rejections.filter(rejection => rejection.reason === 'unsafe_url').length, 4);
  assert.equal(itemFor(result).rejections.filter(rejection => rejection.reason === 'invalid_record').length, 3);
  assert.ok(itemFor(result).rejections.every(rejection => !Object.hasOwn(rejection, 'url')));
});

test('disabled/no-match entities remain explicit and output never becomes an approved explanation', () => {
  const result = matchRelatedCoverage(queue, [record('one')], { 'כותרת כבויה': { disabled: true } });
  assert.equal(result.kind, 'related_coverage_draft'); assert.equal(result.reviewStatus, 'draft');
  assert.equal(result.published, false); assert.equal(result.causalInference, false);
  assert.equal(itemFor(result, 'כותרת כבויה').state, 'disabled');
  assert.equal(itemFor(result, 'Another Topic').state, 'no_match');
  assert.equal(result.items.length, queue.items.length);
  for (const item of result.items) {
    assert.equal(item.reviewStatus, 'draft'); assert.equal(Object.hasOwn(item, 'summary'), false);
    for (const link of item.links) assert.equal(link.reason, 'metadata_entity_and_date_window');
  }
  assert.throws(() => matchRelatedCoverage({ ...queue, reviewStatus: 'approved' }, []));
  assert.throws(() => matchRelatedCoverage(queue, null));
  assert.throws(() => matchRelatedCoverage(queue, [], { 'יעקב עמידרור': { disabled: 'yes' } }));
});

test('matching is non-mutating and ignores hostile approval fields in incoming records', () => {
  const input = [record('one', undefined, { reviewStatus: 'approved', summary: 'Invented explanation' })];
  const before = structuredClone({ queue, input, filmRules });
  const result = matchRelatedCoverage(queue, input, filmRules);
  assert.deepEqual({ queue, input, filmRules }, before);
  assert.equal(Object.hasOwn(itemFor(result).links[0], 'reviewStatus'), false);
  assert.equal(Object.hasOwn(itemFor(result).links[0], 'summary'), false);
});
