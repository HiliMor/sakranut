import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildResearchQueue } from '../src/context-pilot-lib.js';
import { matchRelatedCoverage } from '../src/related-coverage-lib.js';
import { RELATED_ENTITY_RULES } from '../src/related-pilot-rules.js';
import { replayKnownMetadata, runRelatedPilot } from '../scripts/related-pilot.mjs';

const snapshot = JSON.parse(readFileSync(new URL('../public/data/snapshot.json', import.meta.url)));
const queue = buildResearchQueue(snapshot);
const now = () => new Date(new Date(snapshot.generatedAt).getTime() + 60_000);
const args = mode => [mode, '--date', queue.dataDate];

function drafts() {
  return {
    schemaVersion: 1, kind: 'context_research_drafts', queueId: queue.queueId, dataDate: queue.dataDate,
    reviewStatus: 'draft', items: queue.items.map((item, i) => ({
      title: item.title, dataDate: queue.dataDate, reviewStatus: 'draft', verdict: 'candidate',
      summary: 'Unapproved interpretation; this must not enter the metadata matcher.', reviewNotes: 'Synthetic test only.',
      sources: [{
        title: `${item.title} סרט`, url: `https://news.example.org/${i}`, publishedDate: queue.dataDate,
        sourceReadAt: snapshot.generatedAt, evidenceBasis: 'full-text', eventDate: queue.dataDate,
      }],
    })),
  };
}

async function runtime(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'sakranut-related-test-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const previous = join(projectRoot, 'data/context-pilot', queue.dataDate);
  await mkdir(previous, { recursive: true });
  await writeFile(join(previous, 'queue.json'), JSON.stringify(queue));
  await writeFile(join(previous, 'drafts.json'), JSON.stringify(drafts()));
  await mkdir(join(projectRoot, 'public/data'), { recursive: true });
  await writeFile(join(projectRoot, 'public/data/context.json'), '{"sentinel":"unchanged"}');
  return { projectRoot, now, previous };
}

test('metadata replay labels seeds honestly and does not consume summaries or event dates', () => {
  const result = replayKnownMetadata(queue, drafts());
  assert.equal(result.discoveryTest, false);
  assert.equal(result.independentlyDiscoveredNews, 0);
  assert.equal(result.inputRecordCount, queue.items.length);
  assert.ok(result.comparison.every(item => item.priorDraftIsGroundTruth === false));
  assert.ok(!JSON.stringify(result).includes('Unapproved interpretation'));
  assert.ok(result.matches.items.every(item => item.links.length === 1));
  const input = drafts(); input.items.pop();
  assert.throws(() => replayKnownMetadata(queue, input), /all queued/);
});

test('benchmark is offline, cached, private and leaves source research and public context unchanged', async t => {
  const env = await runtime(t);
  let requests = 0;
  const options = { ...env, fetchImpl: () => { requests++; throw new Error('Must be offline'); } };
  const before = await readFile(join(env.previous, 'drafts.json'), 'utf8');
  const first = await runRelatedPilot(args('benchmark'), options);
  const second = await runRelatedPilot(args('benchmark'), options);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(requests, 0);
  assert.equal(first.published, false);
  assert.equal(first.reviewStatus, 'draft');
  assert.ok(first.outputPath.startsWith(join(env.projectRoot, 'data/related-coverage')));
  assert.equal(await readFile(join(env.projectRoot, 'public/data/context.json'), 'utf8'), '{"sentinel":"unchanged"}');
  assert.equal(await readFile(join(env.previous, 'drafts.json'), 'utf8'), before);
});

test('changed inputs and cached results cannot silently overwrite previous runs', async t => {
  const env = await runtime(t);
  const first = await runRelatedPilot(args('benchmark'), env);
  const cached = JSON.parse(await readFile(first.outputPath, 'utf8'));
  cached.result.inputRecordCount++;
  await writeFile(first.outputPath, JSON.stringify(cached));
  await assert.rejects(runRelatedPilot(args('benchmark'), env), /Conflicting or changed/);
  await writeFile(first.outputPath, JSON.stringify({ ...first, resultHash: first.resultHash }));
  const modified = drafts(); modified.items[0].reviewNotes = 'Changed private input.';
  await writeFile(join(env.previous, 'drafts.json'), JSON.stringify(modified));
  await assert.rejects(runRelatedPilot(args('benchmark'), env), /Conflicting or changed/);
});

test('default live probe only requests calendar once; cached reuse makes no network requests', async t => {
  const env = await runtime(t);
  const requests = [];
  const fetchImpl = async url => {
    requests.push(String(url));
    return new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } });
  };
  const first = await runRelatedPilot(args('probe'), { ...env, fetchImpl });
  assert.equal(first.result.newsCoverageStatus, 'not_attempted');
  assert.equal(first.result.discoveryTest, false);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]).hostname, 'www.hebcal.com');
  const second = await runRelatedPilot(args('probe'), { ...env, fetchImpl });
  assert.equal(second.reused, true);
  assert.equal(requests.length, 1);
});

test('discovery failure is unavailable, not evidence of absent news, and is not retried', async t => {
  const env = await runtime(t);
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response('slow down', { status: 429 }); };
  const first = await runRelatedPilot([...args('probe'), '--discovery'], { ...env, fetchImpl });
  assert.equal(first.result.newsCoverageStatus, 'unavailable');
  assert.equal(requests, 2);
  await runRelatedPilot([...args('probe'), '--discovery'], { ...env, fetchImpl });
  assert.equal(requests, 2);
});

test('output override, path traversal, symlinks and interrupted locks are rejected', async t => {
  const env = await runtime(t);
  for (const input of [[], ['probe', '--date', '../elsewhere'], [...args('benchmark'), '--discovery'], [...args('probe'), '--output', '/tmp/elsewhere']]) {
    await assert.rejects(runRelatedPilot(input, env));
  }
  await symlink(join(env.projectRoot, 'public'), join(env.projectRoot, 'data/related-coverage'));
  await assert.rejects(runRelatedPilot(args('benchmark'), env), /symbolic link/);
  const another = await runtime(t);
  const dir = join(another.projectRoot, 'data/related-coverage', queue.dataDate);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'run.lock'), 'interrupted');
  await assert.rejects(runRelatedPilot(args('benchmark'), another), /busy or was interrupted/);
});

test('a future queue cannot start a network probe', async t => {
  const env = await runtime(t);
  let requests = 0;
  await assert.rejects(runRelatedPilot(args('probe'), {
    ...env, now: () => new Date('2000-01-01T00:00:00Z'), fetchImpl: () => { requests++; },
  }), /future/);
  assert.equal(requests, 0);
});

test('production film rules reject a book review with the same title', () => {
  const value = matchRelatedCoverage(queue, [{
    sourceId: 'synthetic', title: 'ביקורת ספר: תעתוע של קולין הובר',
    url: 'https://news.example.org/book', publishedDate: queue.dataDate,
  }], RELATED_ENTITY_RULES);
  const film = value.items.find(item => item.title === 'תעתוע (סרט)');
  assert.ok(film);
  assert.equal(film.links.length, 0);
  assert.equal(film.rejections[0].reason, 'ambiguous_entity');
});

test('invalid private JSON errors never echo source content', async t => {
  const env = await runtime(t);
  await writeFile(join(env.previous, 'drafts.json'), 'PRIVATE_RESEARCH_NOTE=synthetic-example');
  await assert.rejects(runRelatedPilot(args('benchmark'), env), error => {
    assert.equal(error.message, 'Invalid JSON in private pilot input');
    assert.ok(!error.message.includes('PRIVATE_RESEARCH_NOTE'));
    return true;
  });
});
