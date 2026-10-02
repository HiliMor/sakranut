import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectSnapshot, fetchJson } from '../collect.mjs';
import { buildArticle, METHOD, shiftDate, topUrl, windowFor } from '../data-lib.mjs';
import { checkHealth } from '../health.mjs';
import { runDaily } from '../run-daily.mjs';
import { atomicJson, healthcheckEndpoint, makeStatus, readJson, runtimePaths, updateHistoryIndex, validateDailySnapshot, withRuntimeLock } from '../runtime-lib.mjs';

const quiet = { log() {}, warn() {}, error() {} };
const noLock = (_dir, work) => work();
const clock = time => () => new Date(time);
const sample = (dataDate = '2026-10-01', generatedAt = '2026-10-02T03:20:00Z') => {
  const { seriesStart, baselineStart, baselineEnd } = windowFor(dataDate);
  const items = Array.from({ length: 35 }, (_, i) => ({ timestamp: `${shiftDate(seriesStart, i).replaceAll('-', '')}00`, views: i === 34 ? 1000 : 100 }));
  return {
    schemaVersion: 1, generatedAt, dataDate, seriesStart, baselineStart, baselineEnd,
    source: { name: 'Wikimedia Analytics API', license: 'CC0 1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', url: 'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html', policyUrl: 'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html', topUrl: topUrl(dataDate) },
    method: METHOD,
    coverage: { requestedDate: dataDate, fallbackDays: 0, topListCount: 1, candidateCount: 1, articleCount: 1, failures: [] },
    articles: [buildArticle({ article: 'ישראל', rank: 1 }, items, dataDate)], uncomparedArticles: [],
  };
};
async function runtime(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wiki-interest-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const options = dir => ({ runtimeDir: dir, lock: noLock, logger: quiet, now: clock('2026-10-02T06:20:00Z'), healthcheckUrl: '' });

test('collector is import-safe, configurable and produces a validated 35-day snapshot', async () => {
  const fixture = sample();
  const calls = [];
  const result = await collectSnapshot({
    requestedDate: fixture.dataDate, maxFallbackDays: 0, logger: quiet, now: clock('2026-10-02T06:20:00Z'), waitImpl: async () => {},
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return new Response(JSON.stringify(url.includes('/top/') ? { items: [{ year: '2026', month: '10', day: '01', articles: [{ article: 'ישראל', rank: 1 }] }] } : { items: fixture.articles[0].series.map(p => ({ timestamp: p.date.replaceAll('-', '') + '00', views: p.views })) }));
    },
  });
  assert.equal(result.dataDate, '2026-10-01');
  assert.equal(result.articles[0].series.length, 35);
  assert.equal(result.coverage.fallbackDays, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].request.headers['User-Agent'], /^Sakranut\/0\.2 \(https:\/\/github\.com\/HiliMor\/sakranut\) Node\.js$/);
});

test('scheduled collection does not silently fall back when yesterday is unpublished', async () => {
  let calls = 0;
  await assert.rejects(collectSnapshot({ requestedDate: '2026-10-01', maxFallbackDays: 0, now: clock('2026-10-02T06:20:00Z'), logger: quiet, waitImpl: async () => {}, fetchImpl: async () => { calls++; return new Response('', { status: 404 }); } }), error => error.status === 404);
  assert.equal(calls, 1);
});

test('collector protects partial and future data; minimum coverage is 75% strict complete series', async () => {
  await assert.rejects(collectSnapshot({ requestedDate: '2026-10-02', now: clock('2026-10-02T06:20:00Z'), fetchImpl: () => { throw new Error('Should not fetch'); } }), /completed UTC/);
  const fixture = sample();
  const collect = failures => collectSnapshot({ requestedDate: '2026-10-01', maxFallbackDays: 0, now: clock('2026-10-02T06:20:00Z'), logger: quiet, waitImpl: async () => {}, fetchImpl: async url => {
    if (url.includes('/top/')) return Response.json({ items: [{ year: '2026', month: '10', day: '01', articles: Array.from({ length: 4 }, (_, i) => ({ article: `ערך_${i}`, rank: i + 1 })) }] });
    const index = Number(decodeURIComponent(url).match(/ערך_(\d)/)[1]);
    const series = fixture.articles[0].series.slice(index < failures ? 1 : 0);
    return Response.json({ items: series.map(p => ({ timestamp: p.date.replaceAll('-', '') + '00', views: p.views })) });
  } });
  const accepted = await collect(1);
  assert.equal(accepted.articles.length, 3);
  assert.equal(accepted.coverage.failures.length, 1);
  await assert.rejects(collect(2), error => error.code === 'PARTIAL_DATA');
});

test('fetch obeys Retry-After and stops instead of exposing arbitrary URLs', async () => {
  let calls = 0;
  const delays = [];
  const result = await fetchJson('https://example.invalid/data', { waitImpl: async n => { delays.push(n); }, fetchImpl: async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '4' } }) : Response.json({ ok: true }) });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(delays, [200, 4000, 200]);
  await assert.rejects(fetchJson('https://example.invalid/data', { waitImpl: async () => {}, fetchImpl: async () => new Response('', { status: 503, headers: { 'retry-after': '120' } }) }), error => error.code === 'STOP_COLLECTION');
});

test('first daily run archives and publishes, repeat skips without refreshing last success', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  let calls = 0;
  const first = await runDaily({ ...options(dir), collect: async args => { calls++; assert.equal(args.requestedDate, '2026-10-01'); assert.equal(args.maxFallbackDays, 0); return sample(); } });
  assert.equal(first.published, true);
  assert.equal(first.status.state, 'healthy');
  assert.equal(first.status.lastSuccessAt, '2026-10-02T06:20:00.000Z');
  assert.equal(first.status.coverage.articleCount, 1);
  assert.equal(first.status.monitoring.configured, false);
  assert.equal((await readJson(join(paths.history, '2026-10-01.json'))).dataDate, '2026-10-01');
  const second = await runDaily({ ...options(dir), now: clock('2026-10-02T09:20:00Z'), collect: async () => { calls++; throw new Error('Do not fetch again'); } });
  assert.equal(second.published, false);
  assert.equal(calls, 1);
  assert.equal(second.status.lastSuccessAt, first.status.lastSuccessAt);
  assert.equal(second.status.checkedAt, '2026-10-02T09:20:00.000Z');
  assert.deepEqual(await readJson(paths.status), second.status);
});

test('same-day legacy upgrade re-collects once, retains the prior revision and then skips', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  const legacy = sample(); delete legacy.uncomparedArticles;
  await atomicJson(paths.snapshot, legacy);
  let calls = 0;
  const fresh = sample('2026-10-01', '2026-10-02T06:19:00Z');
  const upgraded = await runDaily({ ...options(dir), collect: async () => { calls++; return fresh; } });
  assert.equal(upgraded.published, true);
  assert.equal(upgraded.status.state, 'healthy');
  assert.deepEqual(await readJson(paths.snapshot), fresh);
  const revisions = await readdir(join(paths.history, 'revisions'));
  assert.equal(revisions.length, 1);
  assert.deepEqual(await readJson(join(paths.history, 'revisions', revisions[0])), legacy);
  const skipped = await runDaily({ ...options(dir), now: clock('2026-10-02T09:20:00Z'), collect: async () => { calls++; throw new Error('No repeat fetch'); } });
  assert.equal(calls, 1);
  assert.equal(skipped.published, false);
  assert.equal(skipped.status.lastSuccessAt, upgraded.status.lastSuccessAt);
});

test('failed same-day upgrade retains a usable legacy snapshot byte-for-byte', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  const legacy = sample(); delete legacy.uncomparedArticles;
  await atomicJson(paths.snapshot, legacy);
  const before = await readFile(paths.snapshot, 'utf8');
  const result = await runDaily({ ...options(dir), collect: async () => { throw Object.assign(new Error('Not ready'), { code: 'PARTIAL_DATA' }); } });
  assert.equal(result.published, false);
  assert.equal(result.status.lastSuccessAt, legacy.generatedAt);
  assert.equal(await readFile(paths.snapshot, 'utf8'), before);
  const wrongFormat = await runDaily({ ...options(dir), collect: async () => legacy });
  assert.equal(wrongFormat.exitCode, 1);
  assert.equal(await readFile(paths.snapshot, 'utf8'), before);
});

test('unavailable/partial upstream retains byte-identical last-good data, then ages stale', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  await runDaily({ ...options(dir), collect: async () => sample() });
  const before = await readFile(paths.snapshot, 'utf8');
  for (const error of [Object.assign(new Error('unpublished'), { status: 404 }), Object.assign(new Error('incomplete'), { code: 'PARTIAL_DATA' })]) {
    const result = await runDaily({ ...options(dir), now: clock('2026-10-03T06:20:00Z'), collect: async () => { throw error; } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.status.state, 'waiting');
    assert.equal(result.status.lastSuccessAt, '2026-10-02T06:20:00.000Z');
    assert.equal(await readFile(paths.snapshot, 'utf8'), before);
  }
  const stale = await runDaily({ ...options(dir), now: clock('2026-10-04T06:20:00Z'), collect: async () => { throw Object.assign(new Error('unpublished'), { status: 404 }); } });
  assert.equal(stale.status.state, 'stale');
  assert.equal(await readFile(paths.snapshot, 'utf8'), before);
});

test('bad schema, old day, future day and errors never replace good public snapshot', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  await runDaily({ ...options(dir), collect: async () => sample() });
  const before = await readFile(paths.snapshot, 'utf8');
  const bad = sample('2026-10-02'); bad.articles[0].series.pop();
  for (const collect of [async () => bad, async () => sample(), async () => sample('2026-10-03'), async () => { throw new Error('failure https://secret.example/credential'); }]) {
    const result = await runDaily({ ...options(dir), now: clock('2026-10-03T06:20:00Z'), collect });
    assert.equal(result.exitCode, 1);
    assert.equal(result.status.state, 'error');
    assert.equal(await readFile(paths.snapshot, 'utf8'), before);
    assert.doesNotMatch(JSON.stringify(result.status), /secret|credential/);
  }
});

test('history explicitly records gaps rather than inventing missed collections', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  await runDaily({ ...options(dir), collect: async () => sample() });
  await runDaily({ ...options(dir), now: clock('2026-10-05T06:20:00Z'), collect: async () => sample('2026-10-04', '2026-10-05T06:10:00Z') });
  const index = await readJson(join(paths.history, 'index.json'));
  assert.deepEqual(index.availableDates, ['2026-10-01', '2026-10-04']);
  assert.deepEqual(index.missingDates, ['2026-10-02', '2026-10-03']);
  assert.equal((await readJson(paths.snapshot)).dataDate, '2026-10-04');
});

test('health uses wall clock, never masks stale runner and exits2 without a snapshot', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  const missing = await checkHealth(options(dir));
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.status.state, 'error');
  await runDaily({ ...options(dir), collect: async () => sample() });
  const result = await checkHealth({ ...options(dir), now: clock('2026-10-02T12:20:01Z') });
  assert.equal(result.exitCode, 2);
  assert.equal(result.status.state, 'stale');
  assert.equal(result.status.checkedAt, '2026-10-02T06:20:00.000Z');
  assert.equal(result.status.healthCheckedAt, '2026-10-02T12:20:01.000Z');
  assert.equal((await readJson(paths.state)).checkedAt, '2026-10-02T06:20:00.000Z');
});

test('health pings only dedicated validated endpoint, no URL leaks, no false configured flag', async t => {
  const dir = await runtime(t);
  await runDaily({ ...options(dir), collect: async () => sample() });
  const endpoint = 'https://hc-ping.com/11111111-2222-3333-4444-555555555555';
  const calls = [], logs = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response('OK'); };
  const healthy = await checkHealth({ ...options(dir), healthcheckUrl: endpoint, fetchImpl });
  assert.equal(healthy.exitCode, 0);
  assert.equal(healthy.status.monitoring.configured, true);
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].init.redirect, 'error');
  await checkHealth({ ...options(dir), now: clock('2026-10-04T06:20:00Z'), healthcheckUrl: endpoint, fetchImpl });
  assert.equal(calls[1].url, `${endpoint}/fail`);
  const failedPing = await checkHealth({ ...options(dir), healthcheckUrl: endpoint, fetchImpl: async () => { throw new Error(endpoint); }, logger: { ...quiet, error: line => logs.push(line) } });
  assert.equal(failedPing.exitCode, 1);
  assert.doesNotMatch(logs.join(' '), /11111111|hc-ping/);
  for (const value of ['http://hc-ping.com/x', 'https://evil.test/11111111-2222-3333-4444-555555555555', `${endpoint}?secret=x`, `${endpoint}/fail`, 'https://user:secret@hc-ping.com/11111111-2222-3333-4444-555555555555']) assert.throws(() => healthcheckEndpoint(value), /Invalid dedicated/);
  let network = false;
  const unconfigured = await checkHealth({ ...options(dir), fetchImpl: async () => { network = true; } });
  assert.equal(unconfigured.status.monitoring.configured, false);
  assert.equal(network, false);
});

test('atomic writes use unique temporary files and leave no partial destination', async t => {
  const dir = await runtime(t), path = join(dir, 'output.json');
  await Promise.all(Array.from({ length: 12 }, (_, i) => atomicJson(path, { index: i, content: 'x'.repeat(100) })));
  assert.ok(Number.isInteger((await readJson(path)).index));
  assert.deepEqual(await readdir(dir), ['output.json']);
  const circular = {}; circular.circular = circular;
  const before = await readFile(path, 'utf8');
  await assert.rejects(atomicJson(path, circular));
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await readdir(dir), ['output.json']);
});

test('runtime validates coverage and cannot call collection before acquiring lock', async t => {
  const dir = await runtime(t);
  const bad = sample(); bad.coverage.articleCount = 2;
  assert.throws(() => validateDailySnapshot(bad, '2026-10-01'));
  let fetched = false;
  await assert.rejects(runDaily({ ...options(dir), collect: async () => { fetched = true; }, lock: async () => { throw Object.assign(new Error('busy'), { code: 'LOCK_BUSY' }); } }), error => error.code === 'LOCK_BUSY');
  assert.equal(fetched, false);
});

test('inconsistent runner state cannot report healthy against valid published data', async t => {
  const dir = await runtime(t), paths = runtimePaths(dir);
  await runDaily({ ...options(dir), collect: async () => sample() });
  const valid = await readJson(paths.state);
  for (const mutation of [
    { outcome: 'made-up' }, { schemaVersion: 2 }, { dataDate: '2026-09-30' },
    { targetDate: '2026-10-03' }, { targetDate: '2026-09-30' },
    { lastSuccessAt: null }, { lastSuccessAt: '2026-10-01T12:00:00Z' },
    { checkedAt: '2026-10-02T04:00:00Z' }, { checkedAt: '2026-10-02T07:00:00Z' },
  ]) {
    await atomicJson(paths.state, { ...valid, ...mutation });
    const result = await checkHealth(options(dir));
    assert.equal(result.status.state, 'error', JSON.stringify(mutation));
    assert.equal(result.exitCode, 2);
    assert.equal(result.status.dataDate, '2026-10-01');
  }
});

test('Linux flock excludes concurrent owners and releases after exception', { skip: process.platform !== 'linux' }, async t => {
  const dir = await runtime(t);
  await assert.rejects(withRuntimeLock(dir, async () => {
    await assert.rejects(withRuntimeLock(dir, async () => { throw new Error('Never runs'); }), error => error.code === 'LOCK_BUSY');
    throw new Error('test failure');
  }), /test failure/);
  assert.equal(await withRuntimeLock(dir, async () => 'released'), 'released');
});

test('manual scheduled runner rejects unsupported OS explicitly', { skip: process.platform === 'linux' }, async t => {
  const dir = await runtime(t);
  await assert.rejects(withRuntimeLock(dir, async () => {}), error => error.code === 'LOCK_UNSUPPORTED');
});
