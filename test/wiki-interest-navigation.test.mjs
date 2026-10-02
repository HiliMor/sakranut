import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leadingArticle, detailChartMarkup } from '../src/article-view.js';
import { selectDiscoveryArticles } from '../src/discovery-lib.js';

const snapshot = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the overview leader is independent of list sorting, search and opened detail', () => {
  const before = structuredClone(snapshot);
  const leader = leadingArticle(snapshot);
  assert.equal(leader.title, 'יעקב עמידרור');
  for (const sort of ['surge', 'popular', 'lasting']) {
    const matches = selectDiscoveryArticles(snapshot, sort, 'סאמי');
    assert(matches.length);
    assert.notEqual(matches[0].title, leader.title);
    detailChartMarkup(matches[0]);
    assert.equal(leadingArticle(snapshot), leader);
  }
  assert.deepEqual(snapshot, before);
});
test('a new snapshot recalculates the leader instead of retaining a navigation selection', () => {
  const updated = structuredClone(snapshot);
  const next = updated.articles.find(article => article.title.includes('סאמי'));
  next.ratio = leadingArticle(snapshot).ratio + 1;
  assert.equal(leadingArticle(updated).title, next.title);
  assert.notEqual(leadingArticle(snapshot).title, next.title);
});
test('detail shows its own 14-day chart and points to the adjacent accessible table', () => {
  const article = snapshot.articles.find(article => article.title.includes('סאמי'));
  const markup = detailChartMarkup(article);
  assert.match(markup, /class="detail-chart"/);
  assert.match(markup, /סאמי/);
  assert.match(markup, /14 ימים/);
  assert.match(markup, /טבלת 14 הימים מופיעה בהמשך חלון הפירוט/);
  assert.doesNotMatch(markup, /זמינה בכפתור/);
  assert.equal((markup.match(/class="chart-path"/g) || []).length, 1);
});
test('incomplete histories never acquire a comparison graph', () => {
  assert(snapshot.uncomparedArticles.length);
  for (const partial of snapshot.uncomparedArticles) assert.equal(detailChartMarkup(partial), '');
});
test('detail chart escapes article names', () => {
  const markup = detailChartMarkup({ ...snapshot.articles[0], title: '<img src=x onerror="bad()">' });
  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /&lt;img/);
});
test('overview-replacement controls are absent; both explicit close paths use the same dialog', () => {
  assert.doesNotMatch(main, /selectedTitle|show-in-chart|מבט מקרוב/);
  assert.match(main, /const a = leadingArticle\(snapshot\)/);
  assert.match(html, /class="dialog-toolbar"><button class="dialog-return">חזרה לרשימה/);
  for (const control of ['dialog-close', 'dialog-return']) {
    assert(main.includes(`$('.${control}').addEventListener('click', () => $('#detail').close())`));
  }
  assert.match(main, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(main, /window\.scrollTo\(\{ left: detailOpener\.scrollX, top: detailOpener\.scrollY/);
});
test('automatic display updates cannot change the open detail or its underlying list', () => {
  assert.match(main, /isVisible: \(\) => !document\.hidden && !\$\('#detail'\)\.open/);
  const resolvedGuard = main.indexOf("if (!canApply() || $('#detail').open) return;");
  assert(resolvedGuard > main.indexOf('await loadLiveData'));
  assert(resolvedGuard < main.indexOf('lastLoad = result'));
});
