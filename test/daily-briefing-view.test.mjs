import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dailyBriefingMarkup, dailyChangeMarkup } from '../src/daily-briefing-view.js';

const snapshot = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
const pair = (title, before, after) => ({ title, views: after, series: [{ date: '2026-09-30', views: before }, { date: '2026-10-01', views: after }] });
const data = articles => ({ dataDate: '2026-10-01', articles });

test('dated briefing renders measured changes and distinct detail controls', () => {
  const markup = dailyBriefingMarkup(snapshot);
  assert.match(markup, /1 באוקטובר 2026 לעומת 30 בספטמבר 2026/);
  assert.equal((markup.match(/class="briefing-item /g) || []).length, 3);
  assert.match(markup, /20,633/);
  assert.match(markup, /13,737/);
  assert.match(markup, /ירידה ביום אחד/);
  assert.match(markup, /aria-label="פירוט השינוי היומי: עומאן"/);
  assert.match(markup, /לא לבסיס החודשי/);
  assert.doesNotMatch(markup, /נכנס לעשירייה|הסיבה לזינוק|היום בבוקר|אתמול/);
});
test('briefing titles and button attributes are escaped', () => {
  const markup = dailyBriefingMarkup(data([pair('<img onerror="bad()">', 3, 100)]));
  assert.doesNotMatch(markup, /<img|data-title="<|aria-label="[^"]*<img/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /&quot;bad\(\)&quot;/);
});
test('zero observations are shown literally, not converted to percentages', () => {
  const markup = dailyBriefingMarkup(data([pair('ערך', 0, 150)]));
  assert.match(markup, /מ־<bdi>0<\/bdi> ל־<bdi>150<\/bdi>/);
  assert.doesNotMatch(markup, /Infinity|NaN|%/);
});
test('missing measurements and unchanged measurements have distinct empty states', () => {
  assert.match(dailyBriefingMarkup(data([])), /אין כרגע מספיק נתונים/);
  assert.match(dailyBriefingMarkup(data([pair('ערך', 10, 10)])), /מספר הצפיות לא השתנה/);
  assert.equal(dailyBriefingMarkup({ dataDate: 'invalid' }), '');
});
test('detail repeats the measured daily comparison without calling it a monthly-baseline trend', () => {
  const markup = dailyChangeMarkup(pair('ערך', 21895, 8158), '2026-10-01');
  assert.match(markup, /לעומת 30 בספטמבר/);
  assert.match(markup, /13,737 צפיות פחות/);
  assert.match(markup, /מ־<bdi>21,895<\/bdi> ל־<bdi>8,158<\/bdi>/);
  assert.doesNotMatch(markup, /בסיס|סיבה/);
  assert.equal(dailyChangeMarkup({ title: 'אין זוג ימים', views: 20, series: [{ date: '2026-10-01', views: 20 }] }, '2026-10-01'), '');
});
