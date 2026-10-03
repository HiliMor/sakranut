import test from 'node:test';
import assert from 'node:assert/strict';
import { newsSearchUrl } from '../src/news-search.js';

test('article search uses a fixed HTTPS provider and Hebrew Israel locale', () => {
  const url = new URL(newsSearchUrl('יעקב_עמידרור', '2026-10-01'));
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), '"יעקב עמידרור" after:2026-09-30 before:2026-10-03');
  assert.equal(url.searchParams.get('hl'), 'he');
  assert.equal(url.searchParams.get('gl'), 'IL');
  assert.equal(url.hash, '');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
});

test('title normalization handles whitespace, underscores and Unicode without changing input', () => {
  const title = '  Cafe\u0301__\tאביב\n ';
  const url = new URL(newsSearchUrl(title, '2024-02-29'));
  assert.equal(url.searchParams.get('q'), '"Café אביב" after:2024-02-28 before:2024-03-02');
  assert.equal(title, '  Cafe\u0301__\tאביב\n ');
});

test('embedded quotation marks cannot terminate the quoted title phrase', () => {
  const url = new URL(newsSearchUrl('צה"ל “חדשות”', '2026-10-01'));
  const query = url.searchParams.get('q');
  assert.equal(query, '"צה״ל ״חדשות״" after:2026-09-30 before:2026-10-03');
  assert.equal(query.match(/"/g).length, 2);
});

test('URL and HTML metacharacters remain title text rather than parameters or navigation', () => {
  const title = 'javascript:alert(1)&hl=en#fragment <script>" OR site:evil.test';
  const url = new URL(newsSearchUrl(title, '2026-10-01'));
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.pathname, '/search');
  assert.equal(url.hash, '');
  assert.equal(url.searchParams.get('hl'), 'he');
  assert.deepEqual([...url.searchParams.keys()], ['q', 'hl', 'gl']);
  assert.equal(url.searchParams.get('q'), '"javascript:alert(1)&hl=en#fragment <script>״ OR site:evil.test" after:2026-09-30 before:2026-10-03');
  assert.equal(url.href.includes('<script>'), false);
});

test('invalid or missing article titles produce no external link', () => {
  for (const title of [undefined, null, 4, {}, '', ' _ \n\t', 'a\u0000b', 'a\u007fb', 'a'.repeat(513)]) {
    assert.equal(newsSearchUrl(title, '2026-10-01'), null);
  }
});

test('dates must be real ISO calendar days, including leap-day correctness', () => {
  for (const date of [undefined, null, 20261001, '', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-10-1', '2026-10-01T00:00:00Z', ' 2026-10-01', '2026-10-01&hl=en', '0000-01-01', '9999-12-31']) {
    assert.equal(newsSearchUrl('ערך', date), null, String(date));
  }
  assert.notEqual(newsSearchUrl('ערך', '2024-02-29'), null);
});

test('search boundaries are based on the snapshot date, not the computer date', () => {
  const query = new URL(newsSearchUrl('ערך', '2020-01-01')).searchParams.get('q');
  assert.equal(query, '"ערך" after:2019-12-31 before:2020-01-03');
});

test('date windows cross month and year boundaries without local timezone shifts', () => {
  assert.equal(new URL(newsSearchUrl('ערך', '2026-12-31')).searchParams.get('q'), '"ערך" after:2026-12-30 before:2027-01-02');
  assert.equal(new URL(newsSearchUrl('ערך', '2026-03-01')).searchParams.get('q'), '"ערך" after:2026-02-28 before:2026-03-03');
});
