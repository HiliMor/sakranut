import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { articleRangeUrl, parseDate, shiftDate, windowFor } from './data-lib.mjs';
import { fetchJson } from './collect.mjs';
import { atomicJson, readJson, runtimePaths } from './runtime-lib.mjs';
import { validateSnapshot } from './src/ui-lib.js';
import { TRACKING_DAYS, validateTracks, weeklyPatterns } from './src/tracking-lib.js';
import { normalizeTitle, validTitle, validRetrievedAt } from './src/identification.js';

export function parseRange(items, startDate, endDate) {
  parseDate(startDate); parseDate(endDate);
  if (startDate > endDate || !Array.isArray(items) || !items.length) throw new Error('Unavailable daily observations');
  const seen = new Set();
  return items.map(item => {
    const stamp = String(item?.timestamp ?? '');
    if (!/^\d{8}00$/.test(stamp)) throw new Error('Invalid daily timestamp');
    const date = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
    parseDate(date);
    if (date < startDate || date > endDate || seen.has(date) || !Number.isSafeInteger(item.views) || item.views < 0) throw new Error('Invalid daily observation');
    seen.add(date);
    return { date, views: item.views };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export function validateTrackingCache(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.items) || value.items.length > 2000) throw new Error('Invalid private tracking cache');
  if (value.retryAt && !validRetrievedAt(value.retryAt)) throw new Error('Invalid cache retry time');
  const seen = new Set();
  for (const item of value.items) {
    if (!validTitle(item.title) || item.title !== normalizeTitle(item.title) || seen.has(item.title)
      || !validRetrievedAt(item.fetchedAt) || !Array.isArray(item.series)) throw new Error('Invalid cached article');
    seen.add(item.title);
    parseDate(item.checkedFrom); parseDate(item.checkedThrough);
    if (item.checkedFrom > item.checkedThrough || Date.parse(item.fetchedAt) < Date.parse(item.checkedThrough) + 86400000) throw new Error('Invalid cached coverage');
    const checked = parseRange(item.series.map(point => ({ timestamp: `${point.date.replaceAll('-', '')}00`, views: point.views })), item.checkedFrom, item.checkedThrough);
    if (JSON.stringify(checked) !== JSON.stringify(item.series)) throw new Error('Unordered cache');
    if (item.retryAt && !validRetrievedAt(item.retryAt)) throw new Error('Invalid retry time');
  }
  return value;
}

export function mergeObservations(existing = [], incoming = []) {
  const points = new Map(existing.map(point => [point.date, point.views]));
  for (const point of incoming) points.set(point.date, point.views);
  return [...points].sort(([a], [b]) => a.localeCompare(b)).map(([date, views]) => ({ date, views }));
}

export async function readMeasurements(runtimeDir, dataDate, now = new Date()) {
  const paths = runtimePaths(runtimeDir), start = shiftDate(dataDate, -(TRACKING_DAYS - 1));
  const snapshots = [];
  const names = (await readdir(paths.history)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  for (const name of names) {
    const date = name.slice(0, 10);
    if (date < start || date > dataDate) continue;
    try {
      const snapshot = validateSnapshot(await readJson(join(paths.history, name)));
      if (snapshot.dataDate !== date || Date.parse(snapshot.generatedAt) > now.getTime()) throw new Error('Mismatched history date');
      snapshots.push(snapshot);
    } catch { /* Invalid private history cannot enlarge the cohort. */ }
  }
  return snapshots;
}

export function seedTracking(cache, snapshots) {
  const entries = new Map(cache.items.map(item => [item.title, structuredClone(item)])), membership = new Map();
  for (const snapshot of snapshots) {
    for (const title of [...snapshot.articles.map(article => article.title), ...snapshot.coverage.failures.map(item => item.title)]) {
      const dates = membership.get(title) ?? [];
      if (!dates.includes(snapshot.dataDate)) dates.push(snapshot.dataDate);
      membership.set(title, dates.sort());
    }
    for (const article of [...snapshot.articles, ...(snapshot.uncomparedArticles ?? [])]) {
      const old = entries.get(article.title);
      entries.set(article.title, { title: article.title, series: mergeObservations(old?.series, article.series),
        checkedFrom: old && old.checkedFrom < snapshot.seriesStart ? old.checkedFrom : snapshot.seriesStart,
        checkedThrough: old && old.checkedThrough > snapshot.dataDate ? old.checkedThrough : snapshot.dataDate,
        fetchedAt: old && old.fetchedAt > snapshot.generatedAt ? old.fetchedAt : snapshot.generatedAt,
        ...(old?.retryAt ? { retryAt: old.retryAt } : {}) });
    }
  }
  return { entries, membership };
}

export async function publishTracks({ runtimeDir, snapshot, now = new Date(), logger = console, fetchImpl, waitImpl,
  maxRequests = 80, maxDurationMs = 60_000 } = {}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 0 || maxRequests > 80
    || !Number.isInteger(maxDurationMs) || maxDurationMs < 0 || maxDurationMs > 60_000) throw new Error('Invalid tracking request budget');
  const paths = runtimePaths(runtimeDir);
  const snapshots = await readMeasurements(runtimeDir, snapshot.dataDate, now);
  if (!snapshots.some(item => item.dataDate === snapshot.dataDate)) snapshots.push(validateSnapshot(snapshot));
  let cache = { schemaVersion: 1, items: [] };
  try {
    const old = await readJson(paths.trackingCache);
    if (old) {
      cache = validateTrackingCache(old);
      if (cache.items.some(item => Date.parse(item.fetchedAt) > now.getTime() || item.checkedThrough > snapshot.dataDate)) throw new Error('Future cache');
    }
  }
  catch { cache = { schemaVersion: 1, items: [] }; logger.warn('Tracking: invalid cache ignored; rebuild only from validated observations.'); }
  const { entries, membership } = seedTracking(cache, snapshots);
  let retryAt = cache.retryAt && Date.parse(cache.retryAt) > now.getTime() ? cache.retryAt : null;
  const activeTitles = [...membership].sort(([a, datesA], [b, datesB]) =>
    (entries.get(a)?.checkedThrough ?? '').localeCompare(entries.get(b)?.checkedThrough ?? '')
    || datesB.at(-1).localeCompare(datesA.at(-1)) || a.localeCompare(b, 'he')).map(([title]) => title);
  let requests = 0, failures = 0;
  const started = Date.now();
  for (const title of activeTitles) {
    const old = entries.get(title), start = windowFor(membership.get(title)[0]).seriesStart;
    if (old?.checkedFrom <= start && old.checkedThrough >= snapshot.dataDate) continue;
    if (old?.retryAt && Date.parse(old.retryAt) > now.getTime()) continue;
    if (retryAt) break;
    if (requests >= maxRequests || Date.now() - started >= maxDurationMs) break;
    // Fetch just the missing tail in normal operation; a newly recovered title
    // gets its full comparison window. Requests are always sequential/bounded.
    const from = old && old.checkedFrom <= start ? shiftDate(old.checkedThrough, 1) : start;
    try {
      requests += 1;
      const response = await fetchJson(articleRangeUrl(title, from, snapshot.dataDate), { fetchImpl, waitImpl });
      const incoming = parseRange(response.items, from, snapshot.dataDate);
      entries.set(title, { title, series: mergeObservations(old?.series, incoming), checkedFrom: old && old.checkedFrom < from ? old.checkedFrom : from,
        checkedThrough: snapshot.dataDate, fetchedAt: now.toISOString() });
    } catch (error) {
      failures += 1;
      if (old) entries.set(title, { ...old, retryAt: new Date(now.getTime() + 3 * 3600_000).toISOString() });
      logger.warn('Tracking: optional series unavailable; missing counts remain unknown.');
      if (error.code === 'STOP_COLLECTION') {
        retryAt = error.retryAt ?? new Date(now.getTime() + 3 * 3600_000).toISOString();
        break;
      }
    }
  }
  const seriesStart = windowFor(shiftDate(snapshot.dataDate, -(TRACKING_DAYS - 1))).seriesStart;
  // Keep at most this measured window; long retention lives in the archive.
  const active = activeTitles.flatMap(title => {
    const item = entries.get(title);
    if (!item) return [];
    const series = item.series.filter(point => point.date >= seriesStart && point.date <= snapshot.dataDate);
    return series.length ? [{ ...item, series, checkedFrom: item.checkedFrom < seriesStart ? seriesStart : item.checkedFrom }] : [];
  });
  const nextCache = validateTrackingCache({ schemaVersion: 1, items: active, ...(retryAt ? { retryAt } : {}) });
  await atomicJson(paths.trackingCache, nextCache);
  const product = validateTracks({ schemaVersion: 1, generatedAt: now.toISOString(), dataDate: snapshot.dataDate,
    periodStart: shiftDate(snapshot.dataDate, -(TRACKING_DAYS - 1)), seriesStart,
    availableDates: snapshots.map(item => item.dataDate).sort(),
    // Fetch priority changes as the queue catches up; public item order must
    // not. Keep the same measured product byte-stable on repeat checks.
    items: [...activeTitles].sort().map(title => ({ title, sampleDates: membership.get(title), series: active.find(item => item.title === title)?.series ?? [] })) });
  const previous = await readJson(paths.tracks).catch(() => null);
  const unchanged = previous && JSON.stringify({ ...previous, generatedAt: product.generatedAt }) === JSON.stringify(product);
  if (!unchanged) await atomicJson(paths.tracks, product);
  const patterns = weeklyPatterns(product, snapshot.dataDate);
  return { requests, failures, titles: activeTitles, tracked: product.items.length,
    priorityTitles: [...new Set([...patterns.persistent, ...patterns.cooled].map(article => article.title))],
    pending: activeTitles.filter(title => !entries.get(title) || entries.get(title).checkedThrough < snapshot.dataDate).length, changed: !unchanged };
}
