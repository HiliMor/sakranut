import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, readJson, runtimePaths } from './runtime-lib.mjs';
import { validateSnapshot } from './src/ui-lib.js';
import { validArchiveDate, validateArchive } from './src/archive-state.js';

const pick = (object, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));

// No directory alias to private history: export only validated measurement fields.
// Unknown fields, operator notes, revisions and runner state cannot enter this product.
export function archiveProjection(snapshot) {
  validateSnapshot(snapshot);
  const projection = pick(snapshot, ['schemaVersion', 'generatedAt', 'dataDate', 'seriesStart', 'baselineStart', 'baselineEnd', 'collectionOrigin']);
  projection.source = pick(snapshot.source, ['name', 'license', 'licenseUrl', 'url', 'policyUrl', 'topUrl']);
  projection.method = pick(snapshot.method, ['project', 'access', 'agent', 'baselineDays', 'displayDays', 'minimumBaseline', 'timezone', 'candidateSelection', 'exclusions', 'baseline', 'missingData', 'ratio', 'excess', 'elevated', 'activeDays']);
  projection.method.trends = pick(snapshot.method.trends, ['rising', 'sustained', 'cooling', 'steady', 'insufficient']);
  projection.method.limitations = [...snapshot.method.limitations];
  projection.coverage = pick(snapshot.coverage, ['requestedDate', 'fallbackDays', 'topListCount', 'candidateCount', 'articleCount']);
  projection.coverage.failures = snapshot.coverage.failures.map(item => pick(item, ['title', 'error']));
  const points = series => series.map(point => pick(point, ['date', 'views']));
  projection.articles = snapshot.articles.map(article => ({
    ...pick(article, ['title', 'rank', 'url', 'sourceUrl', 'views', 'baseline', 'ratio', 'excess', 'activeDays', 'trend']), series: points(article.series),
  }));
  if (snapshot.uncomparedArticles) projection.uncomparedArticles = snapshot.uncomparedArticles.map(article => ({
    ...pick(article, ['title', 'rank', 'url', 'sourceUrl', 'views', 'reason']),
    series: points(article.series), missingDates: [...article.missingDates],
  }));
  return validateSnapshot(projection);
}

export async function publishArchive({ runtimeDir, snapshot, now = new Date(), logger = console, force = false }) {
  const paths = runtimePaths(runtimeDir);
  let previous = null;
  try { previous = validateArchive(await readJson(paths.archiveIndex)); } catch { /* Rebuild from validated history. */ }
  if (!force && previous?.latestDate === snapshot.dataDate && previous.latestGeneratedAt === snapshot.generatedAt
    && await stat(join(paths.archive, `${snapshot.dataDate}.json`)).then(() => true, () => false)) {
    return { index: previous, titles: [], changed: false };
  }
  const dates = (await readdir(paths.history)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map(name => name.slice(0, 10)).filter(date => validArchiveDate(date) && date <= snapshot.dataDate).sort();
  const availableDates = [], titles = new Set();
  for (const date of dates) {
    let safe;
    try {
      const value = date === snapshot.dataDate ? snapshot : await readJson(join(paths.history, `${date}.json`));
      if (value?.dataDate !== date || Date.parse(value.generatedAt) > now.getTime()) throw new Error('Invalid archived date');
      safe = archiveProjection(value);
    } catch {
      logger.warn('Archive: skipped an invalid historical measurement; no synthetic day was created.');
      continue;
    }
    const destination = join(paths.archive, `${date}.json`);
    let existing = null;
    try { existing = await readJson(destination); } catch { /* Atomic replacement below. */ }
    if (JSON.stringify(existing) !== JSON.stringify(safe)) await atomicJson(destination, safe);
    availableDates.push(date);
    for (const article of [...safe.articles, ...(safe.uncomparedArticles ?? [])]) titles.add(article.title);
  }
  if (availableDates.at(-1) !== snapshot.dataDate) throw new Error('Latest archived measurement missing');
  const index = validateArchive({ schemaVersion: 1, generatedAt: now.toISOString(), latestDate: snapshot.dataDate,
    latestGeneratedAt: snapshot.generatedAt, availableDates });
  // Publish the index last so its options only point to completed, valid products.
  await atomicJson(paths.archiveIndex, index);
  return { index, titles: [...titles], changed: true };
}
