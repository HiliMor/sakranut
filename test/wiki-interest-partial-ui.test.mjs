import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { comparisonResultMessage, coverageSummary, partialCardsMarkup, partialResultMessage, selectUncomparedArticles } from '../src/partial-history.js';
import { snapshotDisplayKey } from '../src/live-state.js';
import { selectArticles } from '../src/ui-lib.js';

const snapshot = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
const partial = {
  title: 'דוגמה_בלי_היסטוריה', url: 'https://untrusted.example/', sourceUrl: 'https://wikimedia.org/',
  rank: 7, reason: 'incomplete_history', views: 1264,
  series: [{ date: snapshot.dataDate, views: 1264 }], missingDates: [snapshot.seriesStart]
};

test('incomplete articles have their own measured-day counts, without ratios, charts or cause claims', () => {
  const markup = partialCardsMarkup([partial]);
  assert.match(markup, /1,264/);
  assert.match(markup, /צפיות ביום המדידה/);
  assert.match(markup, /נתונים זמינים ל־1 מתוך 35 ימים/);
  assert.match(markup, /ימים חסרים/);
  assert.match(markup, /חוסר ברשומה אינו מוכיח אפס צפיות/);
  assert.doesNotMatch(markup, /<svg|baseline|trend-tag|>פי |זינוק|ערך חדש|סיבת|בגלל/);
});

test('unknown latest-day views stay unknown rather than becoming zero; measured zero remains valid', () => {
  const absent = partialCardsMarkup([{ ...partial, views: null }]);
  assert.match(absent, /אין נתון ליום המדידה/);
  assert.doesNotMatch(absent, /<strong>0<\/strong>/);
  const zero = partialCardsMarkup([{ ...partial, views: 0 }]);
  assert.match(zero, /<strong>0<\/strong>/);
  assert.doesNotMatch(zero, /אין נתון ליום המדידה/);
});

test('article text and attributes are escaped and the only article link is built on Wikipedia', () => {
  const hostile = { ...partial, title: '<img src=x onerror="alert(1)"> & test', url: 'javascript:alert(1)' };
  const markup = partialCardsMarkup([hostile]);
  assert.doesNotMatch(markup, /<img|href="javascript:|href="https:\/\/untrusted/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /&quot;/);
  assert.match(markup, /href="https:\/\/he.wikipedia.org\/wiki\//);
  assert.match(markup, /rel="noopener noreferrer"/);
});

test('search finds a partial-only title independently of full-history sort and preserves source order', () => {
  const articles = [{ ...partial, title: 'בדיקה_יחידה', rank: 9 }, { ...partial, title: 'בדיקה_נוספת', rank: 2 }];
  assert.equal(selectArticles(snapshot.articles, 'surge', 'בדיקה יחידה').length, 0);
  assert.equal(selectUncomparedArticles(articles, ' בדיקה יחידה ').length, 1);
  assert.deepEqual(selectUncomparedArticles(articles, 'בדיקה').map(article => article.rank), [2, 9]);
  assert.deepEqual(articles.map(article => article.rank), [9, 2]);
  assert.deepEqual(selectUncomparedArticles(undefined, 'בדיקה'), []);
  assert.match(comparisonResultMessage({ count: 0, shown: 0, partialCount: 1, query: 'בדיקה יחידה' }), /בסעיף הבא/);
  assert.match(comparisonResultMessage({ count: 0, shown: 0, partialCount: 0 }), /לא נמצאו ערכים מתאימים/);
});

test('new coverage distinguishes displayed incomplete articles from unavailable collection results', () => {
  const current = { ...snapshot, articles: snapshot.articles.slice(0, 24), uncomparedArticles: Array(6).fill(partial), coverage: { ...snapshot.coverage, candidateCount: 30 } };
  const completePresentation = coverageSummary(current);
  assert.equal(completePresentation.unavailable, 0);
  assert.match(completePresentation.sample, /24 ערכים להשוואה · 6 ללא היסטוריה מלאה · מתוך 30/);
  assert.match(completePresentation.detail, /6 ערכים.*נכללים בדירוג הצפיות ובחיפוש/);
  assert.doesNotMatch(completePresentation.detail, /לא מוצגים|שגיאת איסוף/);
  assert.equal(completePresentation.warning, '');
  const mixed = coverageSummary({ ...current, uncomparedArticles: [partial, partial] });
  assert.equal(mixed.unavailable, 4);
  assert.match(mixed.detail, /2 ערכים.*נכללים בדירוג הצפיות ובחיפוש/);
  assert.match(mixed.detail, /4 ערכים נוספים לא מוצגים/);
  assert.equal(mixed.warning, 'לא ניתן להציג 4 ערכים בגלל נתונים לא זמינים. פירוט בפרטי הנתונים.');
  assert.doesNotMatch(mixed.warning, /היסטוריה|2 ערכים/);
});

test('legacy snapshots still flag exclusions without claiming those articles are now displayed', () => {
  const legacy = { ...snapshot, uncomparedArticles: undefined, articles: Array(24).fill(snapshot.articles[0]), coverage: { ...snapshot.coverage, candidateCount: 30 } };
  const coverage = coverageSummary(legacy);
  assert.equal(coverage.partial, 0);
  assert.equal(coverage.unavailable, 6);
  assert.match(coverage.detail, /6 ערכים נוספים לא מוצגים/);
  assert.doesNotMatch(coverage.detail, /מוצגים בנפרד/);
  assert.match(coverage.warning, /לא ניתן להציג 6 ערכים/);
  assert.equal(coverageSummary({ ...legacy, coverage: { ...legacy.coverage, candidateCount: 24 } }).warning, '');
});

test('partial cards keep coverage details collapsed and omit repeated dates and timezone', () => {
  const markup = partialCardsMarkup([partial]);
  const [visible, details] = markup.split('<details');
  assert.match(visible, /1,264/);
  assert.doesNotMatch(visible, /נתונים זמינים|ימים חסרים|35|UTC|2026/);
  assert.match(details, /^ class="partial-availability"><summary/);
  assert.doesNotMatch(details, /^.*?\bopen(?:[\s=>])/);
  assert.match(details, /פירוט הנתונים<span class="sr-only">:/);
  assert.match(details, /נתונים זמינים ל־1 מתוך 35 ימים/);
  assert.doesNotMatch(markup, /partial-measurement-date|UTC/);
});

test('partial section has no redundant footer unless searching, and then announces the result', () => {
  assert.equal(partialResultMessage({ count: 6 }), '');
  assert.equal(partialResultMessage({ count: 6, query: '  ' }), '');
  assert.match(partialResultMessage({ count: 1, query: 'בדיקה' }), /נמצא ערך נוסף אחד/);
  assert.match(partialResultMessage({ count: 3, query: 'בדיקה' }), /נמצאו 3 ערכים נוספים/);
  assert.match(partialResultMessage({ count: 0, query: 'בדיקה' }), /לא נמצאו/);
});

test('collection metadata is behind one native closed disclosure, while alerts remain outside', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const details = html.match(/<details id="data-details"[^>]*>([\s\S]*?)<\/details>/);
  assert(details);
  assert.doesNotMatch(details[0].split('>')[0], /\bopen\b/);
  assert.match(details[1], /<summary>פרטי הנתונים ואפשרויות עדכון<\/summary>/);
  for (const id of ['snapshot-note', 'server-check-note', 'sample-size', 'coverage-note', 'runtime-note', 'snapshot-link']) {
    assert(details[1].includes(`id="${id}"`));
    assert.equal(html.split(`id="${id}"`).length - 1, 1);
  }
  assert.match(details[1], /UTC/);
  assert.match(details[1], /בכניסה לאתר, בחזרה ללשונית ובכל שעה כשהיא גלויה/);
  assert.match(details[1], /JSON/);
  assert(html.indexOf('id="update-warning"') > html.indexOf(details[0]) + details[0].length);
  assert.match(html, /id="update-warning"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /id="coverage-warning"|id="uncompared-count"|class="snapshot-bar"/);
  assert.doesNotMatch(main, /\$\('#data-details'\)\.innerHTML\s*=/);
  assert.match(main, /if \(coverage\.warning\) warnings\.push\(coverage\.warning\)/);
});

test('polling notices partial measurements, metadata and coverage changes without rerendering for timestamps only', () => {
  const current = { ...snapshot, uncomparedArticles: [partial] };
  const key = snapshotDisplayKey(current);
  for (const patch of [
    { uncomparedArticles: [{ ...partial, views: null }] },
    { uncomparedArticles: [{ ...partial, missingDates: [] }] },
    { uncomparedArticles: [{ ...partial, series: [] }] },
    { coverage: { ...snapshot.coverage, candidateCount: snapshot.coverage.candidateCount + 1 } }
  ]) assert.notEqual(key, snapshotDisplayKey({ ...current, ...patch }));
  assert.equal(key, snapshotDisplayKey({ ...current, generatedAt: '2099-01-01T00:00:00Z' }));
  assert.equal(snapshotDisplayKey({ ...snapshot, uncomparedArticles: undefined }), snapshotDisplayKey({ ...snapshot, uncomparedArticles: [] }));
});
