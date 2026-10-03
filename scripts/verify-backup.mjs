import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shiftDate } from '../data-lib.mjs';
import { validateDailySnapshot } from '../runtime-lib.mjs';
import { validateArchive } from '../src/archive-state.js';
import { validateTracks } from '../src/tracking-lib.js';
import { validateDescriptions } from '../src/identification.js';
import { validateStatus } from '../src/live-state.js';
import { validateTrackingCache } from '../tracking-products.mjs';

const allowed = path => /^(?:public\/(?:snapshot|status|archive|tracks|descriptions)\.json|public\/archive\/\d{4}-\d{2}-\d{2}\.json|history\/(?:index|\d{4}-\d{2}-\d{2})\.json|history\/revisions\/\d{4}-\d{2}-\d{2}-\d{8}T\d{9}Z\.json|(?:runner-state|description-cache|tracking-cache)\.json)$/.test(path);
const required = ['public/snapshot.json','public/status.json','public/archive.json','public/tracks.json',
  'public/descriptions.json','history/index.json','runner-state.json','description-cache.json','tracking-cache.json'];

export function validateBackupManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100_000) throw new Error('Invalid backup manifest');
  const seen = new Set();
  for (const file of manifest.files) {
    if (!allowed(file?.path) || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid manifest entry');
    seen.add(file.path);
  }
  if (required.some(path => !seen.has(path))) throw new Error('Incomplete runtime backup');
  return manifest;
}

// Read only. Never extract an archive or restore over the live runtime here.
export async function verifyBackup({ runtimeDir, manifest, now = new Date() }) {
  validateBackupManifest(manifest);
  if (!isAbsolute(runtimeDir) || resolve(runtimeDir) === '/' || !(await lstat(runtimeDir)).isDirectory()) throw new Error('Use a dedicated restored directory');
  const actual = [];
  async function walk(dir = '') {
    for (const entry of await readdir(join(runtimeDir,dir))) {
      const path = dir ? `${dir}/${entry}` : entry;
      const metadata = await lstat(join(runtimeDir,path));
      if (metadata.isSymbolicLink()) throw new Error('Backup links are not allowed');
      if (metadata.isDirectory()) {
        if (!['public','public/archive','history','history/revisions'].includes(path)) throw new Error('Unexpected backup directory');
        await walk(path);
      } else if (metadata.isFile() && allowed(path)) actual.push(path);
      else throw new Error('Unexpected backup entry');
    }
  }
  await walk();
  const expected = manifest.files.map(file => file.path).sort();
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) throw new Error('Missing or extra backup files');
  const values = new Map();
  for (const file of manifest.files) {
    const bytes = await readFile(join(runtimeDir,file.path));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Backup checksum mismatch');
    values.set(file.path,JSON.parse(bytes.toString('utf8')));
  }
  const completedDate = shiftDate(now.toISOString().slice(0,10),-1);
  const snapshot = validateDailySnapshot(values.get('public/snapshot.json'),completedDate);
  const status = validateStatus(values.get('public/status.json'));
  const archive = validateArchive(values.get('public/archive.json'));
  const tracks = validateTracks(values.get('public/tracks.json'));
  validateDescriptions(values.get('public/descriptions.json'));
  validateTrackingCache(values.get('tracking-cache.json'));
  if (status.dataDate !== snapshot.dataDate || status.coverage.articleCount !== snapshot.articles.length
    || status.coverage.candidateCount !== snapshot.coverage.candidateCount) throw new Error('Invalid restored status');
  const dates = expected.filter(path => /^history\/\d{4}-\d{2}-\d{2}\.json$/.test(path)).map(path => path.slice(8,-5));
  for (const date of dates) {
    const historic = validateDailySnapshot(values.get(`history/${date}.json`),completedDate);
    const projection = validateDailySnapshot(values.get(`public/archive/${date}.json`),completedDate);
    if (historic.dataDate !== date || projection.dataDate !== date || historic.generatedAt !== projection.generatedAt) throw new Error('Invalid restored edition');
  }
  for (const path of expected.filter(path => path.startsWith('history/revisions/'))) {
    const revision = validateDailySnapshot(values.get(path),completedDate);
    if (revision.dataDate !== path.slice('history/revisions/'.length, 'history/revisions/'.length+10)) throw new Error('Invalid restored revision');
  }
  if (JSON.stringify(dates) !== JSON.stringify(archive.availableDates)
    || JSON.stringify(dates) !== JSON.stringify(values.get('history/index.json').availableDates)
    || archive.latestDate !== snapshot.dataDate || archive.latestGeneratedAt !== snapshot.generatedAt
    || tracks.dataDate !== snapshot.dataDate) throw new Error('Restored products are not aligned');
  return { schemaVersion:1, verifiedAt:now.toISOString(), phase:'data_restore_verified',
    filesVerified:expected.length, historyDates:dates.length, dataDate:snapshot.dataDate,
    trackedTitles:tracks.items.length, fullServerRestoreVerified:false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeFlag,runtimeDir,manifestFlag,manifestPath,...extra]=process.argv.slice(2);
  if (runtimeFlag!=='--runtime'||manifestFlag!=='--manifest'||!runtimeDir||!manifestPath||extra.length) {
    console.error('Usage: verify-backup.mjs --runtime ABS_RESTORED_DIR --manifest ABS_MANIFEST_JSON'); process.exitCode=1;
  } else Promise.resolve().then(async()=>verifyBackup({runtimeDir,manifest:JSON.parse(await readFile(manifestPath,'utf8'))}))
    .then(result=>console.log(JSON.stringify(result,null,2)))
    .catch(()=>{console.error('Backup validation failed; no runtime files were changed.');process.exitCode=2;});
}
