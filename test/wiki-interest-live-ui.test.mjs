import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTEXT_QUALIFICATION, POLL_INTERVAL_MS, STATUS_MAX_AGE_MS, STATUS_MAX_FUTURE_SKEW_MS, validateStatus, deriveLiveState,
  safeSourceUrl, validateContexts, contextFor, contextMarkup, fetchJson, loadLiveData, snapshotDisplayKey
} from '../src/live-state.js';

const snapshot = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
const timestamp = offset => new Date(Date.parse(snapshot.generatedAt) + offset).toISOString();
const now = Date.parse(timestamp(60 * 60 * 1000));
const status = {
  schemaVersion: 1, mode: 'scheduled', checkedAt: timestamp(1000), lastSuccessAt: timestamp(500),
  dataDate: snapshot.dataDate, targetDate: snapshot.dataDate, state: 'healthy', message: 'Snapshot published',
  coverage: { candidateCount: snapshot.coverage.candidateCount, articleCount: snapshot.articles.length, failuresCount: snapshot.coverage.failures.length },
  monitoring: { configured: true }
};
const context = {
  title: snapshot.articles[0].title, dataDate: snapshot.dataDate, reviewStatus: 'approved', reviewedAt: timestamp(1500),
  summary: 'דיווח מתוארך עשוי להסביר את העלייה. זו אינה הוכחת סיבה.', qualification: CONTEXT_QUALIFICATION,
  sources: [{ label: 'מקור לבדיקה', url: 'https://example.org/story', publishedDate: snapshot.dataDate }]
};
const contexts = { schemaVersion: 1, items: [context] };
const baseUrl = new URL('https://example.org/curiosity/');
const response = (body, options = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...options });
const served = { 'snapshot.json': snapshot, 'status.json': status, 'context.json': contexts };
const fixtureFetch = overrides => async url => {
  const name = new URL(url).pathname.split('/').at(-1);
  const override = overrides?.[name];
  if (override instanceof Error) throw override;
  if (override instanceof Response) return override;
  return response(override ?? served[name]);
};

test('daily automated label requires coherent publication and recent runner status', () => {
  assert.equal(validateStatus(status), status);
  const live = deriveLiveState(snapshot, status, now);
  assert.equal(live.automated, true);
  assert.match(live.label, /עדכון יומי אוטומטי/);
  assert.equal(live.label, 'עדכון יומי אוטומטי');
  assert.equal(live.checkedAt, status.checkedAt);
  assert.deepEqual(live.warnings, []);
  assert.equal(POLL_INTERVAL_MS, 3600000);
});

test('missing status is manual, while failed status does not claim a manual run', () => {
  const live = deriveLiveState(snapshot, null, now);
  assert.equal(live.automated, false);
  assert.match(live.label, /ידני/);
  assert.equal(live.checkedAt, null);
  assert.doesNotMatch(deriveLiveState(snapshot, null, now, true).label, /ידני/);
});

test('different dates, mismatched count, earlier publication or future check never claim automation', () => {
  for (const patch of [
    { dataDate: '2020-01-01' },
    { coverage: { ...status.coverage, articleCount: status.coverage.articleCount - 1 } },
    { lastSuccessAt: timestamp(-1) },
    { checkedAt: new Date(now + STATUS_MAX_FUTURE_SKEW_MS + 1).toISOString() },
    { lastSuccessAt: null }
  ]) {
    const live = deriveLiveState(snapshot, { ...status, ...patch }, now);
    assert.equal(live.automated, false);
    assert.match(live.warnings.join(' '), /אינו תואם/);
  }
});

test('hourly browser polling does not relax clock-skew validation or remove entry and return checks', () => {
  assert.equal(STATUS_MAX_FUTURE_SKEW_MS, 300000);
  assert(STATUS_MAX_FUTURE_SKEW_MS < POLL_INTERVAL_MS);
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /document\.addEventListener\('visibilitychange', \(\) => refresh\.request\('automatic'\)\)/);
  assert.match(main, /intervalMs: POLL_INTERVAL_MS, isVisible: \(\) => !document\.hidden/);
  assert.match(main.trim(), /refresh\.request\('initial'\);$/);
});

test('stale measurements are visibly flagged even with a healthy fresh runner status', () => {
  const staleNow = Date.parse(`${snapshot.dataDate}T00:00:00Z`) + 3 * 86400000;
  const live = deriveLiveState(snapshot, { ...status, checkedAt: new Date(staleNow).toISOString() }, staleNow);
  assert.equal(live.staleData, true);
  assert.match(live.warnings.join(' '), /מלפני 3 ימים/);
  assert.match(live.label, /דורש בדיקה/);
});

test('six-hour-old runner status cannot be masked by newer health probe metadata', () => {
  const lateNow = Date.parse(status.checkedAt) + STATUS_MAX_AGE_MS + 1;
  const live = deriveLiveState(snapshot, { ...status, healthCheckedAt: new Date(lateNow).toISOString() }, lateNow);
  assert.equal(live.automated, false);
  assert.match(live.warnings.join(' '), /6/);
});

test('waiting, failed runtime and unconfigured monitor are explicit distinct states', () => {
  assert.match(deriveLiveState(snapshot, { ...status, state: 'waiting' }, now).detail, /ממתינים/);
  const failed = deriveLiveState(snapshot, { ...status, state: 'error', monitoring: { configured: false } }, now);
  assert.match(failed.label, /דורש בדיקה/);
  assert.match(failed.warnings.join(' '), /תקלה/);
  assert.match(failed.warnings.join(' '), /טרם הוגדר ניטור/);
});

test('invalid status metadata fails closed including counters, dates and last-success ordering', () => {
  for (const patch of [
    { mode: 'manual' }, { schemaVersion: 2 }, { dataDate: '2026-02-30' }, { checkedAt: 'yesterday' },
    { targetDate: '2026-10' }, { state: 'good' }, { monitoring: {} }, { lastSuccessAt: timestamp(2000) },
    { coverage: { ...status.coverage, failuresCount: -1 } },
    { coverage: { ...status.coverage, articleCount: status.coverage.candidateCount + 1 } }
  ]) assert.throws(() => validateStatus({ ...status, ...patch }));
  assert.doesNotThrow(() => validateStatus({ ...status, dataDate: null, lastSuccessAt: null, state: 'error' }));
});

test('context must be approved and exactly match both data day and article title', () => {
  const approved = validateContexts({ schemaVersion: 1, items: [context, { ...context, title: 'draft', reviewStatus: 'draft' }] });
  assert.equal(approved.items.length, 1);
  assert.equal(contextFor(approved, context.title, context.dataDate).summary, context.summary);
  assert.equal(contextFor(approved, context.title.replaceAll(' ', '_'), context.dataDate), null);
  assert.equal(contextFor(approved, context.title, '2026-10-02'), null);
  assert.match(contextMarkup(null), /לא נוסף עדיין הסבר בדוק/);
});

test('unsafe sources, missing review or qualifications never appear as approved explanations', () => {
  for (const patch of [
    { reviewedAt: null }, { qualification: 'הסיבה בוודאות' }, { summary: '' }, { sources: [] },
    { sources: [{ ...context.sources[0], url: 'javascript:alert(1)' }] },
    { sources: [{ ...context.sources[0], url: 'http://example.org' }] },
    { sources: [{ ...context.sources[0], url: 'https://user:secret@example.org' }] },
    { sources: [{ ...context.sources[0], publishedDate: 'invalid' }] }
  ]) assert.equal(validateContexts({ schemaVersion: 1, items: [{ ...context, ...patch }] }).items.length, 0);
  assert.throws(() => validateContexts({ schemaVersion: 1, items: [context, context] }));
  assert.throws(() => validateContexts({ items: [] }));
  assert.equal(safeSourceUrl('//example.org'), null);
  assert.equal(safeSourceUrl('https://example.org/a'), 'https://example.org/a');
});

test('approved source strings are escaped in narrative, attributes and labels', () => {
  const input = { ...context, summary: '<script>alert(1)</script>', sources: [{ ...context.sources[0], label: '<img onerror="x">', url: 'https://example.org/?q="x"&a=1' }] };
  const approved = validateContexts({ schemaVersion: 1, items: [input] }).items[0];
  const markup = contextMarkup(approved);
  assert(!markup.includes('<script>'));
  assert(!markup.includes('<img'));
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&amp;a=1/);
  assert.match(markup, /noopener noreferrer/);
  assert.match(markup, /הקשר אפשרי, לא סיבתיות מוכחת/);
});

test('parallel load uses deployment-relative data paths and independent no-cache requests', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return fixtureFetch()(url);
  };
  const result = await loadLiveData({ baseUrl, fetchImpl });
  assert.deepEqual(result.snapshot, snapshot);
  assert.deepEqual(result.status, status);
  assert.equal(result.contexts.items.length, 1);
  assert.equal(calls.length, 3);
  assert(calls.every(call => call.url.startsWith('https://example.org/curiosity/data/')));
  assert(calls.every(call => call.options.cache === 'no-store' && call.options.signal instanceof AbortSignal));
});

test('missing optional files preserve valid manual snapshot without an initial page error', async () => {
  const result = await loadLiveData({ baseUrl, fetchImpl: fixtureFetch({
    'status.json': new Response('', { status: 404 }),
    'context.json': new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
  }) });
  assert.deepEqual(result.snapshot, snapshot);
  assert.equal(result.status, null);
  assert.equal(result.contexts, null);
  assert.equal(result.statusError, null);
  assert.equal(result.contextError, null);
});

test('network, invalid measurement and server errors retain prior validated data', async () => {
  for (const bad of [new Error('offline'), { ...snapshot, dataDate: '2026-02-30' }, new Response('', { status: 503 })]) {
    const result = await loadLiveData({ baseUrl, previousSnapshot: snapshot, fetchImpl: fixtureFetch({ 'snapshot.json': bad }) });
    assert.equal(result.snapshot, snapshot);
    assert(result.snapshotError instanceof Error);
  }
  const empty = await loadLiveData({ baseUrl, fetchImpl: fixtureFetch({ 'snapshot.json': new Error('offline') }) });
  assert.equal(empty.snapshot, null);
});

test('failed status is never reused as proof of automation; failed context keeps previously approved evidence', async () => {
  const result = await loadLiveData({ baseUrl, previousSnapshot: snapshot, previousContexts: contexts, fetchImpl: fixtureFetch({
    'status.json': new Error('offline'), 'context.json': new Error('offline')
  }) });
  assert.equal(result.status, null);
  assert(result.statusError);
  assert(result.contextError);
  assert.equal(result.contexts, contexts);
  assert.equal(contextFor(result.contexts, context.title, '2099-01-01'), null);
});

test('late deployment responses cannot regress an already loaded snapshot', async () => {
  const result = await loadLiveData({ baseUrl, previousSnapshot: { ...snapshot, generatedAt: timestamp(3000) }, fetchImpl: fixtureFetch() });
  assert.equal(result.snapshot.generatedAt, timestamp(3000));
  assert.match(result.snapshotError.message, /regression/);
});

test('fetch timeout aborts instead of leaving a refresh permanently in flight', async () => {
  let signal;
  await assert.rejects(fetchJson(baseUrl, { timeoutMs: 5, fetchImpl: (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } }), /aborted/);
  assert.equal(signal.aborted, true);
});

test('poll signatures ignore publication timestamps but include actual displayed measurements', () => {
  assert.equal(snapshotDisplayKey(snapshot), snapshotDisplayKey({ ...snapshot, generatedAt: timestamp(3000) }));
  assert.notEqual(snapshotDisplayKey(snapshot), snapshotDisplayKey({ ...snapshot, articles: snapshot.articles.slice(1) }));
});
