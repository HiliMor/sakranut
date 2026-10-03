import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDate } from '../data-lib.mjs';
import { validateResearchQueue, validateDrafts } from '../src/context-pilot-lib.js';
import { matchRelatedCoverage } from '../src/related-coverage-lib.js';
import { probeRelatedSources } from '../src/related-sources.js';
import { RELATED_ENTITY_RULES, RELATED_RULES_VERSION } from '../src/related-pilot-rules.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };

async function privatePath(root, area, day, filename) {
  parseDate(day);
  let path = resolve(root);
  for (const part of ['data', area, day, filename].filter(Boolean)) {
    path = join(path, part);
    try { if ((await lstat(path)).isSymbolicLink()) fail('Refusing a symbolic link in a pilot path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path;
}

async function readJson(path, optional = false) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 5 * 1024 * 1024) fail('Invalid or oversized pilot input');
    const bytes = await file.readFile('utf8');
    try { return JSON.parse(bytes); }
    catch { fail('Invalid JSON in private pilot input'); }
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  } finally { await file?.close(); }
}

// Deliberately discard the previous summaries, article bodies, and inferred
// event dates. These are manually discovered seed URLs, NOT new discoveries.
export function replayKnownMetadata(queue, drafts) {
  validateDrafts(drafts, queue);
  if (drafts.items.length !== queue.items.length) fail('Benchmark needs all queued items');
  const records = drafts.items.flatMap(item => item.sources.map((source, index) => ({
    id: `${item.title}:${index}`, sourceId: new URL(source.url).hostname,
    title: source.title, url: source.url, publishedDate: source.publishedDate,
  })));
  const matches = matchRelatedCoverage(queue, records, RELATED_ENTITY_RULES);
  const comparison = queue.items.map(item => {
    const previous = drafts.items.find(value => value.title === item.title);
    const current = matches.items.find(value => value.title === item.title);
    return {
      title: item.title,
      priorDraftVerdict: previous.verdict,
      priorDraftIsGroundTruth: false,
      knownSeedCount: previous.sources.length,
      metadataLinks: current.links.length,
      state: current.state,
      matchedKnownSeedCount: current.links.filter(link => previous.sources.some(source => source.url === link.url)).length,
    };
  });
  return {
    kind: 'seeded_metadata_replay', discoveryTest: false, independentlyDiscoveredNews: 0,
    rulesVersion: RELATED_RULES_VERSION, rulesAreHandReviewed: true,
    inputRecordCount: records.length, matches, comparison,
    limitations: [
      'Seeds and their metadata come from earlier manual research, not automatic discovery or a fresh publisher fetch.',
      'A prior candidate is an unapproved draft, not a gold-standard explanation.',
      'Rules were selected with knowledge of these five examples; this is not a blind evaluation.',
      'Title matching can miss names mentioned only in the article body; related coverage is not a causal explanation.',
    ],
  };
}

function validateCached(value, inputHash, mode) {
  if (value?.schemaVersion !== 1 || value.kind !== 'related_pilot_run' || value.mode !== mode
    || value.inputHash !== inputHash || value.reviewStatus !== 'draft' || value.published !== false
    || value.resultHash !== hash(value.result)) fail('Conflicting or changed cached run; inspect it without overwriting');
  return value;
}

/** Fixed private output, no publication/scheduler, one explicit bounded run. */
export async function runRelatedPilot(args, { projectRoot = ROOT, now = () => new Date(), fetchImpl = fetch } = {}) {
  const [command, dateFlag, day, discoveryFlag, ...rest] = args;
  const includeDiscovery = discoveryFlag === '--discovery';
  if (!['benchmark', 'probe'].includes(command) || dateFlag !== '--date' || !day || rest.length
    || (discoveryFlag && (!includeDiscovery || command !== 'probe'))) {
    fail('Usage: related-pilot.mjs benchmark --date YYYY-MM-DD | probe --date YYYY-MM-DD [--discovery]');
  }
  parseDate(day);
  const queue = validateResearchQueue(await readJson(await privatePath(projectRoot, 'context-pilot', day, 'queue.json')));
  if (queue.dataDate !== day) fail('Queue date does not match requested day');
  const drafts = command === 'benchmark'
    ? await readJson(await privatePath(projectRoot, 'context-pilot', day, 'drafts.json')) : null;
  if (drafts) validateDrafts(drafts, queue);
  const mode = command === 'probe' && includeDiscovery ? 'probe-discovery' : command;
  const inputHash = hash({ queue, drafts, mode, rulesVersion: RELATED_RULES_VERSION, rules: RELATED_ENTITY_RULES });
  const directory = await privatePath(projectRoot, 'related-coverage', day);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const outputPath = await privatePath(projectRoot, 'related-coverage', day, `${mode}.json`);
  const lockPath = await privatePath(projectRoot, 'related-coverage', day, 'run.lock');
  let lock;
  try {
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('Pilot is busy or was interrupted; inspect run.lock before recovery'); throw error; }
    await lock.writeFile(JSON.stringify({ pid: process.pid, mode, dataDate: day }));
    const cached = await readJson(outputPath, true);
    if (cached) return { ...validateCached(cached, inputHash, mode), outputPath, reused: true };
    const instant = now();
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) fail('Invalid clock');
    if (Date.parse(queue.snapshotGeneratedAt) > instant.getTime()) fail('Queue timestamp is in the future');
    const result = command === 'benchmark' ? replayKnownMetadata(queue, drafts) : {
      kind: 'structured_source_probe', discoveryTest: includeDiscovery,
      ...await probeRelatedSources(queue, { fetchImpl, now, includeDiscovery }),
    };
    if (command === 'probe') {
      result.matches = matchRelatedCoverage(queue, result.records, RELATED_ENTITY_RULES);
      // Source failure and missing publication dates must not masquerade as
      // evidence that no coverage existed.
      result.newsCoverageStatus = !includeDiscovery ? 'not_attempted'
        : result.sources.find(source => source.sourceId === 'gdelt')?.status !== 'ok' ? 'unavailable'
          : result.records.length ? 'publication_dates_unverified' : 'no_records_returned';
    }
    const value = {
      schemaVersion: 1, kind: 'related_pilot_run', mode, queueId: queue.queueId, dataDate: day,
      inputHash, createdAt: instant.toISOString(), reviewStatus: 'draft', published: false,
      result, resultHash: hash(result),
    };
    const file = await open(outputPath, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    return { ...value, outputPath, reused: false };
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRelatedPilot(process.argv.slice(2)).then(value => {
    console.log(JSON.stringify({
      mode: value.mode, dataDate: value.dataDate, outputPath: value.outputPath, reused: value.reused,
      reviewStatus: value.reviewStatus, published: false,
      comparison: value.result.comparison,
      sources: value.result.sources,
      calendarItems: value.result.calendarItems,
      newsCoverageStatus: value.result.newsCoverageStatus,
    }, null, 2));
  }).catch(error => {
    console.error(`Related-coverage pilot failed: ${error.code ? 'check private input files and directory permissions' : error.message}`);
    process.exitCode = 1;
  });
}
