import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseDate } from '../data-lib.mjs';
import { buildResearchQueue, validateResearchQueue, validateDrafts } from '../src/context-pilot-lib.js';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

// Refuse redirected runtime folders or queue files. CLI callers cannot choose
// an output directory: research never goes into public/data/context.json.
async function queuePath(projectRoot, dataDate) {
  parseDate(dataDate);
  let current = resolve(projectRoot);
  for (const part of ['data', 'context-pilot', dataDate, 'queue.json']) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Research paths must not contain symbolic links'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

// projectRoot is injected only for isolated tests; the CLI has no such option.
export async function runContextPilot(args, { projectRoot = PROJECT_ROOT, log = console.log } = {}) {
  const [command, flag, value, ...extra] = args;
  if (extra.length || !['queue', 'validate'].includes(command)
    || (command === 'queue' && !(args.length === 1 || (args.length === 3 && flag === '--snapshot' && value)))
    || (command === 'validate' && !(args.length === 3 && flag === '--input' && value))) {
    throw new Error('Usage: context-pilot.mjs queue [--snapshot PATH] | validate --input PATH');
  }
  if (command === 'validate') {
    const drafts = await readJson(resolve(value));
    const path = await queuePath(projectRoot, drafts?.dataDate);
    const queue = validateResearchQueue(await readJson(path));
    validateDrafts(drafts, queue);
    log(`Validated ${drafts.items.length} draft records. No source truth was verified and nothing was published.`);
    return { command, count: drafts.items.length, published: false };
  }
  const snapshotPath = value ? resolve(value) : join(projectRoot, 'public/data/snapshot.json');
  const queue = buildResearchQueue(await readJson(snapshotPath));
  const path = await queuePath(projectRoot, queue.dataDate);
  await mkdir(join(projectRoot, 'data/context-pilot', queue.dataDate), { recursive: true, mode: 0o700 });
  await queuePath(projectRoot, queue.dataDate);
  let reused = false;
  try { await writeFile(path, `${JSON.stringify(queue, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = validateResearchQueue(await readJson(path));
    if (existing.queueId !== queue.queueId) throw new Error('A different queue already exists for this day; refusing to overwrite it');
    reused = true;
  }
  log(`${reused ? 'Reused' : 'Prepared'} ${queue.items.length} pending research items in ${path}. No research ran and nothing was published.`);
  return { command, queue, path, reused, published: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runContextPilot(process.argv.slice(2)).catch(error => {
    console.error(`Context pilot failed: ${error.code ? 'check the input file and research directory' : error.message}`);
    process.exitCode = 1;
  });
}
