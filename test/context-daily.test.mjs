import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArticle, shiftDate, topUrl, windowFor } from '../data-lib.mjs';
import { buildResearchQueue } from '../src/context-pilot-lib.js';
import { runContextDaily } from '../scripts/context-daily.mjs';

const fixture = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
const clock = value => () => new Date(value);
const defaultNow = clock('2026-10-10T12:00:00Z');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function snapshot(dataDate = '2026-10-09') {
  const data = structuredClone(fixture), window = windowFor(dataDate);
  Object.assign(data, { dataDate, generatedAt: `${shiftDate(dataDate, 1)}T01:00:00.000Z`, ...window });
  data.source.topUrl = topUrl(dataDate);
  data.articles = [1, 2].map(index => buildArticle({ article: `ערך_${index}`, rank: index }, Array.from({ length: 35 }, (_, i) => ({
    timestamp: `${shiftDate(window.seriesStart, i).replaceAll('-', '')}00`, views: i === 34 ? index * 1000 : 100,
  })), dataDate));
  data.uncomparedArticles = [];
  data.coverage = { requestedDate: dataDate, fallbackDays: 0, topListCount: 2, candidateCount: 2, articleCount: 2, failures: [] };
  return data;
}
const draftsFor = queue => ({
  schemaVersion: 1, kind: 'context_research_drafts', queueId: queue.queueId, dataDate: queue.dataDate, reviewStatus: 'draft',
  items: queue.items.map(item => ({ title: item.title, dataDate: queue.dataDate, reviewStatus: 'draft', verdict: 'abstain', sources: [], reviewNotes: 'Insufficient evidence; no explanation proposed.' })),
});
async function runtime(t) {
  const root = await mkdtemp(join(tmpdir(), 'sakranut-daily-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'public/data'), { recursive: true });
  await writeFile(join(root, 'public/data/context.json'), '{"untouched":true}');
  return root;
}
async function input(root, dataDate = '2026-10-09') {
  const path = join(root, 'snapshot.json');
  await writeFile(path, JSON.stringify(snapshot(dataDate)));
  return path;
}
const dayPath = (root, date, name) => join(root, 'data/context-pilot', date, `${name}.json`);
const run = (root, args, now = defaultNow) => runContextDaily(args, { projectRoot: root, now });
async function seedDay(root, date, { withDrafts = true } = {}) {
  const queue = buildResearchQueue(snapshot(date));
  await mkdir(join(root, 'data/context-pilot', date), { recursive: true });
  await writeFile(dayPath(root, date, 'queue'), `${JSON.stringify(queue)}\n`);
  if (withDrafts) await writeFile(dayPath(root, date, 'drafts'), JSON.stringify(draftsFor(queue)));
  return queue;
}

test('prepare requires the actual previous UTC day, not Israel local yesterday', async t => {
  const root = await runtime(t), path = await input(root, '2026-10-09');
  const now = clock('2026-10-10T00:30:00+03:00');
  const stale = await run(root, ['prepare', '--snapshot', path], now);
  assert.equal(stale.status, 'blocked'); assert.equal(stale.code, 'snapshot_not_previous_utc_day');
  assert.equal(stale.targetDate, '2026-10-08');
  await input(root, '2026-10-08');
  const ready = await run(root, ['prepare', '--snapshot', path], now);
  assert.equal(ready.status, 'ready_to_research'); assert.equal(ready.dataDate, '2026-10-08');
  assert.equal(ready.published, false); assert.equal(ready.reviewStatus, 'draft');
});

test('prepare runs at most once for the day and refuses fresh or older research in progress', async t => {
  const root = await runtime(t), path = await input(root);
  const first = await run(root, ['prepare', '--snapshot', path]);
  assert.equal(first.status, 'ready_to_research');
  const queueBytes = await readFile(first.queuePath, 'utf8');
  const second = await run(root, ['prepare', '--snapshot', path]);
  assert.equal(second.status, 'awaiting_completion'); assert.equal(second.code, 'queue_in_progress');
  const queue = JSON.parse(queueBytes);
  await writeFile(dayPath(root, queue.dataDate, 'drafts'), JSON.stringify(draftsFor(queue)));
  const third = await run(root, ['prepare', '--snapshot', path]);
  assert.equal(third.status, 'awaiting_completion'); assert.equal(third.code, 'drafts_in_progress');
  await input(root, '2026-10-10');
  const nextDay = await run(root, ['prepare', '--snapshot', path], clock('2026-10-11T12:00:00Z'));
  assert.equal(nextDay.status, 'awaiting_completion'); assert.equal(nextDay.dataDate, '2026-10-09');
  assert.equal(await readFile(first.queuePath, 'utf8'), queueBytes);
  assert.equal(await readFile(join(root, 'public/data/context.json'), 'utf8'), '{"untouched":true}');
});

test('a different valid queue for the current day is a conflict, never overwritten', async t => {
  const root = await runtime(t), path = await input(root);
  const existing = await seedDay(root, '2026-10-09', { withDrafts: false });
  const changed = snapshot(); changed.generatedAt = '2026-10-10T02:00:00.000Z';
  await writeFile(path, JSON.stringify(changed));
  const result = await run(root, ['prepare', '--snapshot', path]);
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'conflicting_queue');
  assert.equal(JSON.parse(await readFile(dayPath(root, existing.dataDate, 'queue'), 'utf8')).queueId, existing.queueId);
});

test('complete requires every exact queued title once; partial and duplicate drafts do not seal', async t => {
  const root = await runtime(t), queue = await seedDay(root, '2026-10-09');
  const drafts = draftsFor(queue); drafts.items.pop();
  await writeFile(dayPath(root, queue.dataDate, 'drafts'), JSON.stringify(drafts));
  const partial = await run(root, ['complete', '--date', queue.dataDate]);
  assert.equal(partial.status, 'blocked'); assert.equal(partial.code, 'incomplete_coverage');
  drafts.items.push(drafts.items[0]);
  await writeFile(dayPath(root, queue.dataDate, 'drafts'), JSON.stringify(drafts));
  const duplicate = await run(root, ['complete', '--date', queue.dataDate]);
  assert.equal(duplicate.code, 'invalid_drafts');
  assert.equal((await readdir(join(root, 'data/context-pilot', queue.dataDate))).includes('completion.json'), false);
});

test('complete seals legacy first-pilot files without a preparation marker and is immutable/idempotent', async t => {
  const root = await runtime(t), queue = await seedDay(root, '2026-10-01');
  const first = await run(root, ['complete', '--date', queue.dataDate]);
  assert.equal(first.status, 'completed'); assert.equal(first.completedDays, 1);
  const path = dayPath(root, queue.dataDate, 'completion'), bytes = await readFile(path, 'utf8'), receipt = JSON.parse(bytes);
  assert.equal(receipt.queueSha256, hash(await readFile(dayPath(root, queue.dataDate, 'queue'))));
  assert.equal(receipt.draftsSha256, hash(await readFile(dayPath(root, queue.dataDate, 'drafts'))));
  assert.deepEqual(receipt.counts, { queued: 2, candidate: 0, abstain: 2 });
  assert.equal(receipt.reviewStatus, 'draft'); assert.equal(receipt.published, false);
  assert.equal((await stat(path)).mode & 0o222, 0);
  const second = await run(root, ['complete', '--date', queue.dataDate], clock('2026-10-10T13:00:00Z'));
  assert.equal(second.status, 'already_completed'); assert.equal(second.completedDays, 1);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('completion rejects future source reads and receipt verification uses its completion time', async t => {
  const root = await runtime(t), queue = await seedDay(root, '2026-10-09');
  const path = dayPath(root, queue.dataDate, 'drafts'), drafts = draftsFor(queue);
  drafts.items[0].sources = [{ url: 'https://www.ynet.co.il/news/article/example', title: 'Recorded source',
    publishedDate: queue.dataDate, sourceReadAt: '2026-10-10T12:00:01.000Z', evidenceBasis: 'full-text' }];
  await writeFile(path, JSON.stringify(drafts));
  const future = await run(root, ['complete', '--date', queue.dataDate]);
  assert.equal(future.status, 'blocked'); assert.equal(future.code, 'invalid_draft_chronology');
  drafts.items[0].sources[0].sourceReadAt = '2026-10-10T11:59:59.000Z';
  await writeFile(path, JSON.stringify(drafts));
  assert.equal((await run(root, ['complete', '--date', queue.dataDate])).status, 'completed');
  // A coherent byte hash must not make a backdated receipt acceptable.
  const receiptPath = dayPath(root, queue.dataDate, 'completion');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.completedAt = '2026-10-10T11:59:58.000Z';
  const { chmod } = await import('node:fs/promises');
  await chmod(receiptPath, 0o600); await writeFile(receiptPath, JSON.stringify(receipt));
  const invalidReceipt = await run(root, ['complete', '--date', queue.dataDate]);
  assert.equal(invalidReceipt.status, 'blocked'); assert.equal(invalidReceipt.code, 'invalid_draft_chronology');
});

test('changed completed artifacts block both repeated completion and future preparation', async t => {
  for (const name of ['queue', 'drafts']) {
    const root = await runtime(t), queue = await seedDay(root, '2026-10-08');
    await run(root, ['complete', '--date', queue.dataDate]);
    const path = dayPath(root, queue.dataDate, name), before = await readFile(path, 'utf8');
    await writeFile(path, `${before}\n`);
    const changed = await run(root, ['complete', '--date', queue.dataDate]);
    assert.equal(changed.status, 'blocked'); assert.equal(changed.code, 'completed_artifacts_changed');
    const prepare = await run(root, ['prepare', '--snapshot', await input(root)]);
    assert.equal(prepare.status, 'blocked'); assert.equal(prepare.code, 'completed_artifacts_changed');
  }
});

test('seven completed days stop further preparation and completion; missing days are not invented', async t => {
  const root = await runtime(t);
  for (let i = 1; i <= 7; i++) {
    const date = `2026-10-0${i}`; await seedDay(root, date);
    const outcome = await run(root, ['complete', '--date', date]);
    assert.equal(outcome.status, i === 7 ? 'pilot_complete' : 'completed'); assert.equal(outcome.completedDays, i);
  }
  const stopped = await run(root, ['prepare', '--snapshot', await input(root)]);
  assert.equal(stopped.status, 'pilot_complete'); assert.equal(stopped.completedDays, 7);
  await seedDay(root, '2026-10-08');
  assert.equal((await run(root, ['complete', '--date', '2026-10-08'])).status, 'pilot_complete');
  assert.equal((await readdir(join(root, 'data/context-pilot', '2026-10-08'))).includes('completion.json'), false);
  assert.equal((await readdir(join(root, 'data/context-pilot'))).includes('2026-10-09'), false);
});

test('completed target cannot prepare again; only next UTC day may create a new queue', async t => {
  const root = await runtime(t), path = await input(root);
  const prepared = await run(root, ['prepare', '--snapshot', path]);
  const queue = JSON.parse(await readFile(prepared.queuePath, 'utf8'));
  await writeFile(dayPath(root, queue.dataDate, 'drafts'), JSON.stringify(draftsFor(queue)));
  assert.equal((await run(root, ['complete', '--date', queue.dataDate])).status, 'completed');
  assert.equal((await run(root, ['prepare', '--snapshot', path])).status, 'already_completed');
  assert.equal((await readdir(join(root, 'data/context-pilot'))).length, 1);
  await input(root, '2026-10-10');
  assert.equal((await run(root, ['prepare', '--snapshot', path], clock('2026-10-11T12:00:00Z'))).status, 'ready_to_research');
});

test('bad JSON, unsafe paths and CLI overrides fail closed without publication', async t => {
  const root = await runtime(t), path = await input(root);
  await writeFile(path, '{invalid');
  assert.equal((await run(root, ['prepare', '--snapshot', path])).code, 'invalid_json');
  for (const args of [['prepare', '--snapshot', path, '--now', '2026-10-10'], ['prepare', '--output', path], ['complete', '--date', '../public']]) {
    assert.equal((await run(root, args)).status, 'blocked');
  }
  const redirected = await runtime(t), inputPath = await input(redirected);
  await mkdir(join(redirected, 'data')); await symlink(join(redirected, 'public/data'), join(redirected, 'data/context-pilot'));
  assert.equal((await run(redirected, ['prepare', '--snapshot', inputPath])).code, 'unsafe_path');
  const linked = await runtime(t), queue = await seedDay(linked, '2026-10-09', { withDrafts: false });
  await symlink(join(linked, 'public/data/context.json'), dayPath(linked, queue.dataDate, 'drafts'));
  assert.equal((await run(linked, ['complete', '--date', queue.dataDate])).code, 'unsafe_path');
});

test('exclusive daily guard prevents concurrent preparation and leaves interrupted locks alone', async t => {
  const root = await runtime(t), path = await input(root);
  const results = await Promise.all([run(root, ['prepare', '--snapshot', path]), run(root, ['prepare', '--snapshot', path])]);
  assert.equal(results.filter(outcome => outcome.status === 'ready_to_research').length, 1);
  assert.ok(results.some(outcome => outcome.code === 'busy_or_interrupted_run' || outcome.status === 'awaiting_completion'));
  const lock = join(root, 'data/context-pilot/daily.lock'); await writeFile(lock, 'interrupted');
  const stopped = await run(root, ['complete', '--date', '2026-10-09']);
  assert.equal(stopped.code, 'busy_or_interrupted_run');
  assert.equal(await readFile(lock, 'utf8'), 'interrupted');
});
