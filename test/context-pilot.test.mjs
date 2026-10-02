import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArticle, shiftDate } from '../data-lib.mjs';
import { buildResearchQueue, validateResearchQueue, validateDrafts, safeResearchSourceUrl } from '../src/context-pilot-lib.js';
import { runContextPilot } from '../scripts/context-pilot.mjs';

const fixture = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
const quiet = () => {};
function snapshot() {
  const result = structuredClone(fixture);
  const candidates = [
    ['rising-high', [100, 100, 100, 100, 100, 100, 3000]],
    ['sustained', [100, 100, 100, 800, 800, 800, 800]],
    ['rising-tie-b', [100, 100, 100, 100, 100, 100, 600]],
    ['rising-tie-a', [100, 100, 100, 100, 100, 100, 600]],
    ['fifth', [100, 100, 100, 100, 100, 100, 400]],
    ['sixth', [100, 100, 100, 100, 100, 100, 200]],
    ['cooling', [100, 100, 10_000, 8000, 7000, 6000, 3000]],
    ['steady', [100, 100, 100, 100, 100, 100, 100]],
    ['low-baseline', [100, 100, 100, 100, 100, 100, 20_000]],
  ];
  result.articles = candidates.map(([title, recent], index) => buildArticle({ article: title, rank: index + 1 }, [
    ...Array(28).fill(title === 'low-baseline' ? 10 : 100), ...recent,
  ].map((views, i) => ({ timestamp: `${shiftDate(result.seriesStart, i).replaceAll('-', '')}00`, views })), result.dataDate));
  result.uncomparedArticles = [];
  result.coverage = { ...result.coverage, topListCount: 9, candidateCount: 9, articleCount: 9, failures: [] };
  return result;
}
function draft(queue) {
  return {
    schemaVersion: 1, kind: 'context_research_drafts', queueId: queue.queueId,
    dataDate: queue.dataDate, reviewStatus: 'draft', items: [{
      title: queue.items[0].title, dataDate: queue.dataDate, reviewStatus: 'draft', verdict: 'candidate',
      summary: 'A dated report may provide context; it does not establish causation.', reviewNotes: 'Operator recorded the source body; independent review still required.',
      sources: [{ url: 'https://www.ynet.co.il/news/article/example', title: 'Source title',
        publishedDate: queue.dataDate, sourceReadAt: `${shiftDate(queue.dataDate, 1)}T12:00:00Z`, evidenceBasis: 'full-text', eventDate: queue.dataDate }],
    }],
  };
}
async function runtime(t) {
  const root = await mkdtemp(join(tmpdir(), 'sakranut-context-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'public/data'), { recursive: true });
  await writeFile(join(root, 'public/data/snapshot.json'), JSON.stringify(snapshot()));
  await writeFile(join(root, 'public/data/context.json'), '{"preserve":"approved context is not a draft output"}');
  return root;
}

test('queue caps five genuine elevated articles, prioritizes ratio/views and excludes cooling or low baselines', () => {
  const data = snapshot(), before = structuredClone(data);
  const queue = buildResearchQueue(data);
  assert.deepEqual(queue.items.map(item => item.title), ['rising-high', 'sustained', 'rising-tie-b', 'rising-tie-a', 'fifth']);
  assert.equal(queue.items.length, 5);
  assert.deepEqual(data, before);
  assert.deepEqual(buildResearchQueue(data), queue);
  for (const item of queue.items) {
    assert.equal(item.researchStatus, 'pending');
    assert.equal(item.dataDate, data.dataDate);
    assert.deepEqual(item.dateWindow, { from: shiftDate(data.dataDate, -2), to: data.dataDate });
    assert.ok(item.searchQueries.every(query => query.includes(item.title)));
    assert.equal(Object.hasOwn(item, 'summary'), false);
    assert.equal(Object.hasOwn(item, 'sources'), false);
  }
});

test('selection never takes partial histories and safely produces an empty queue', () => {
  const queue = buildResearchQueue(fixture);
  assert.ok(queue.items.every(item => fixture.articles.some(article => article.title === item.title)));
  assert.ok(queue.items.every(item => !fixture.uncomparedArticles.some(article => article.title === item.title)));
  const data = snapshot(); data.articles = [data.articles.find(article => article.trend === 'steady')];
  data.coverage = { ...data.coverage, candidateCount: 1, articleCount: 1 };
  assert.deepEqual(buildResearchQueue(data).items, []);
});

test('invalid snapshots and altered queues fail rather than fabricating research', () => {
  assert.throws(() => buildResearchQueue(null));
  const data = snapshot(); data.articles[0].views++;
  assert.throws(() => buildResearchQueue(data));
  const queue = buildResearchQueue(snapshot());
  for (const mutate of [q => q.items[0].ratio++, q => q.items[0].researchStatus = 'approved', q => q.items[0].dateWindow.from = q.dataDate, q => q.queueId = '0'.repeat(64), q => q.items.push(q.items[0]), q => q.items[0].summary = 'invented']) {
    const changed = structuredClone(queue); mutate(changed); assert.throws(() => validateResearchQueue(changed));
  }
});

test('URL checks reject credentials, insecure protocols, local/private hosts and all IP literals', () => {
  assert.equal(safeResearchSourceUrl('https://www.ynet.co.il/news/article/example'), 'https://www.ynet.co.il/news/article/example');
  for (const url of [null, 'javascript:alert(1)', 'http://example.org/', 'https://user:secret@example.org/', 'https://localhost/', 'https://localhost./', 'https://localhost../', 'https://www..ynet.co.il/', 'https://server.internal/', 'https://news.local/', 'https://intranet/', 'https://127.0.0.1/', 'https://10.0.0.1/', 'https://169.254.169.254/', 'https://2130706433/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://8.8.8.8/', 'https://public.example:8443/', 'https://www.ynet.co.il\\@localhost/', 'https://www.ynet.co.il/\nprivate']) assert.equal(safeResearchSourceUrl(url), null, String(url));
});

test('candidate drafts retain draft status and exact queue/day/title without publishing approval', () => {
  const queue = buildResearchQueue(snapshot()), value = draft(queue);
  assert.equal(validateDrafts(value, queue), value);
  assert.equal(value.reviewStatus, 'draft');
  assert.equal(value.items[0].reviewStatus, 'draft');
  delete value.items[0].summary;
  assert.throws(() => validateDrafts(value, queue), /Invalid draft item/);
  value.items[0].verdict = 'abstain';
  assert.doesNotThrow(() => validateDrafts(value, queue));
});

test('drafts cap each article at three sources and candidate summaries cannot be empty', () => {
  const queue = buildResearchQueue(snapshot()), value = draft(queue);
  const source = value.items[0].sources[0];
  value.items[0].sources = Array.from({ length: 3 }, (_, index) => ({ ...source, url: `${source.url}-${index}` }));
  assert.doesNotThrow(() => validateDrafts(value, queue));
  value.items[0].sources.push({ ...source, url: `${source.url}-3` });
  assert.throws(() => validateDrafts(value, queue), /Invalid draft item/);
  value.items[0].verdict = 'abstain';
  assert.throws(() => validateDrafts(value, queue), /Invalid draft item/);
  for (const summary of [undefined, null, '', '  ']) {
    const candidate = draft(queue);
    if (summary === undefined) delete candidate.items[0].summary;
    else candidate.items[0].summary = summary;
    assert.throws(() => validateDrafts(candidate, queue), /Invalid draft item/);
  }
});

test('snippet-only, missing dates or unread bodies require abstention, with explicit nulls retained', () => {
  const queue = buildResearchQueue(snapshot());
  for (const sourcePatch of [{ evidenceBasis: 'snippet' }, { publishedDate: null }, { publishedDate: shiftDate(queue.dataDate, -3) }]) {
    const value = draft(queue); Object.assign(value.items[0].sources[0], sourcePatch);
    assert.throws(() => validateDrafts(value, queue), /otherwise abstain/);
    value.items[0].verdict = 'abstain';
    assert.doesNotThrow(() => validateDrafts(value, queue));
  }
  const value = draft(queue);
  value.items[0].verdict = 'abstain'; value.items[0].sources[0].publishedDate = null;
  value.items[0].sources[0].sourceReadAt = null; value.items[0].sources[0].evidenceBasis = 'snippet';
  assert.doesNotThrow(() => validateDrafts(value, queue));
  value.items[0].sources[0].evidenceBasis = 'full-text';
  assert.throws(() => validateDrafts(value, queue), /Invalid draft source/);
  value.items[0].sources = [];
  assert.doesNotThrow(() => validateDrafts(value, queue));
});

test('approval, wrong identity, malformed/null evidence and unstated metadata are rejected', () => {
  const queue = buildResearchQueue(snapshot());
  const mutations = [
    d => d.reviewStatus = 'approved', d => d.items[0].reviewStatus = 'approved', d => d.items[0].approved = true,
    d => d.queueId = '0'.repeat(64), d => d.items[0].title = 'not queued', d => d.dataDate = shiftDate(queue.dataDate, -1),
    d => d.items[0].dataDate = shiftDate(queue.dataDate, -1), d => d.items[0].verdict = 'approved',
    d => d.items[0].reviewNotes = null, d => d.items[0].summary = 'x'.repeat(601), d => d.items[0].sources = null,
    d => d.items[0].sources[0] = null, d => d.items[0].sources[0].title = null,
    d => delete d.items[0].sources[0].publishedDate, d => delete d.items[0].sources[0].sourceReadAt,
    d => d.items[0].sources[0].publishedDate = '2026-02-30', d => d.items[0].sources[0].sourceReadAt = '2026-02-30T00:00:00Z',
    d => d.items[0].sources[0].evidenceBasis = 'assumed', d => d.items[0].sources[0].eventDate = 'unknown',
    d => d.items[0].sources[0].sourceReadAt = `${shiftDate(queue.dataDate, -1)}T12:00:00Z`,
    d => d.items[0].sources[0].url = 'https://10.0.0.1/', d => d.items[0].sources.push(d.items[0].sources[0]),
    d => d.items.push(d.items[0]),
  ];
  for (const mutate of mutations) { const value = draft(queue); mutate(value); assert.throws(() => validateDrafts(value, queue), undefined, mutate.toString()); }
  assert.throws(() => validateDrafts(null, queue));
});

test('queue CLI writes only its fixed private research location and reuses an identical queue', async t => {
  const root = await runtime(t);
  const publicBefore = await readFile(join(root, 'public/data/context.json'), 'utf8');
  const first = await runContextPilot(['queue'], { projectRoot: root, log: quiet });
  assert.equal(first.path, join(root, 'data/context-pilot', fixture.dataDate, 'queue.json'));
  const second = await runContextPilot(['queue'], { projectRoot: root, log: quiet });
  assert.equal(first.reused, false); assert.equal(second.reused, true);
  assert.equal(first.published, false);
  assert.equal(await readFile(join(root, 'public/data/context.json'), 'utf8'), publicBefore);
  assert.deepEqual(await readdir(join(root, 'data/context-pilot', fixture.dataDate)), ['queue.json']);
  await assert.rejects(runContextPilot(['queue', '--output', join(root, 'public/data/context.json')], { projectRoot: root, log: quiet }), /Usage/);
  await assert.rejects(runContextPilot(['queue', '--force'], { projectRoot: root, log: quiet }), /Usage/);
});

test('existing changed queues are never overwritten', async t => {
  const root = await runtime(t);
  const first = await runContextPilot(['queue'], { projectRoot: root, log: quiet });
  const before = await readFile(first.path, 'utf8');
  const changed = snapshot(); changed.generatedAt = new Date(Date.parse(changed.generatedAt) + 1000).toISOString();
  await writeFile(join(root, 'public/data/snapshot.json'), JSON.stringify(changed));
  await assert.rejects(runContextPilot(['queue'], { projectRoot: root, log: quiet }), /refusing to overwrite/);
  assert.equal(await readFile(first.path, 'utf8'), before);
});

test('validate CLI is read-only and requires an existing matching queue', async t => {
  const root = await runtime(t);
  const prepared = await runContextPilot(['queue'], { projectRoot: root, log: quiet });
  const path = join(root, 'draft.json'), value = draft(prepared.queue);
  await writeFile(path, JSON.stringify(value));
  const queueBefore = await readFile(prepared.path, 'utf8'), draftBefore = await readFile(path, 'utf8');
  const result = await runContextPilot(['validate', '--input', path], { projectRoot: root, log: quiet });
  assert.deepEqual(result, { command: 'validate', count: 1, published: false });
  assert.equal(await readFile(prepared.path, 'utf8'), queueBefore);
  assert.equal(await readFile(path, 'utf8'), draftBefore);
  value.reviewStatus = 'approved'; await writeFile(path, JSON.stringify(value));
  await assert.rejects(runContextPilot(['validate', '--input', path], { projectRoot: root, log: quiet }), /draft research/);
});

test('fixed queue path rejects symlinked research folders and invalid draft dates', async t => {
  const root = await runtime(t);
  await mkdir(join(root, 'data')); await symlink(join(root, 'public/data'), join(root, 'data/context-pilot'));
  await assert.rejects(runContextPilot(['queue'], { projectRoot: root, log: quiet }), /symbolic links/);
  assert.equal((await readdir(join(root, 'public/data'))).length, 2);
  const input = join(root, 'bad-draft.json'); await writeFile(input, JSON.stringify({ dataDate: '../public' }));
  await assert.rejects(runContextPilot(['validate', '--input', input], { projectRoot: root, log: quiet }), /Invalid ISO date/);
});
