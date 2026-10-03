import { setTimeout as wait } from 'node:timers/promises';
import { atomicJson, readJson, runtimePaths } from './runtime-lib.mjs';
import { DESCRIPTION_SOURCE, normalizeTitle, validDescription, validEntityId, validRetrievedAt, validTitle, validateDescriptions } from './src/identification.js';

export const DESCRIPTION_CACHE_MS = 7 * 86400000;
export const DESCRIPTION_BATCH_SIZE = 20;
export const DESCRIPTION_MAX_REQUESTS = 2;
const HOUR_MS = 3600000;

export function descriptionRequestUrl(titles) {
  if (!Array.isArray(titles) || !titles.length || titles.length > DESCRIPTION_BATCH_SIZE || titles.some(title => !validTitle(title))) throw new Error('Invalid description titles');
  // WikibaseClient supplies linked Wikidata terms without depending on WDQS.
  // No redirect resolution or entity-name search: the exact article owns the QID.
  const url = new URL('https://he.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({ action: 'query', titles: titles.map(normalizeTitle).join('|'),
    prop: 'pageprops|pageterms', ppprop: 'wikibase_item', wbptterms: 'description', wbptlanguage: 'he',
    format: 'json', formatversion: '2', maxlag: '5' }).toString();
  return url;
}

export function descriptionsFromResponse(value, titles, fetchedAt) {
  if (value?.error || value?.continue || value?.batchcomplete !== true
    || !Array.isArray(value.query?.pages) || !value.query.pages.length) throw new Error('Invalid Wikidata client response');
  const wanted = new Map(titles.map(title => [normalizeTitle(title), title]));
  const found = new Map();
  for (const page of value.query.pages) {
    if (!validTitle(page?.title) || page.ns !== 0 || !wanted.has(normalizeTitle(page.title))) throw new Error('Mismatched article identity');
    const title = wanted.get(normalizeTitle(page.title));
    if (found.has(title)) throw new Error('Ambiguous article identity');
    if (page.missing !== true && (!Number.isSafeInteger(page.pageid) || page.pageid < 1)) throw new Error('Invalid article identity');
    const id = page.pageprops?.wikibase_item;
    if (id !== undefined && !validEntityId(id)) throw new Error('Invalid linked Wikidata identity');
    const terms = page.terms?.description;
    const text = page.missing !== true && validEntityId(id) && Array.isArray(terms) && terms.length === 1 && validDescription(terms[0]) ? terms[0] : null;
    found.set(title, { title, entityId: page.missing === true ? null : id ?? null, description: text, fetchedAt });
  }
  if (titles.some(title => !found.has(title))) throw new Error('Incomplete Wikidata mapping');
  return titles.map(title => found.get(title));
}

function validCache(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.entries)
    || (value.retryAt !== null && !validRetrievedAt(value.retryAt))) throw new Error('Invalid description cache');
  const seen = new Set();
  for (const item of value.entries) {
    if (!validTitle(item?.title) || seen.has(normalizeTitle(item.title))
      || (item.fetchedAt !== null && !validRetrievedAt(item.fetchedAt))
      || (item.entityId !== null && !validEntityId(item.entityId))
      || (item.description !== null && (!validDescription(item.description) || !item.entityId || !item.fetchedAt))) throw new Error('Invalid description cache entry');
    seen.add(normalizeTitle(item.title));
  }
  return value;
}

function retryTime(header, now) {
  const retryMs = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000
    : header ? Date.parse(header) - now.getTime() : 0;
  const endOfTime = Date.parse('9999-12-31T23:59:59.999Z');
  const requested = retryMs === Infinity ? endOfTime : now.getTime() + Math.max(HOUR_MS, Number.isFinite(retryMs) ? retryMs : 0);
  return new Date(Math.min(endOfTime, requested)).toISOString();
}

export async function publishDescriptions({ runtimeDir, titles, currentTitles = titles, now = new Date(), fetchImpl = globalThis.fetch, waitImpl = wait, logger = console }) {
  const paths = runtimePaths(runtimeDir);
  let cache;
  try { cache = validCache(await readJson(paths.descriptionCache)); }
  catch {
    let retained = [];
    try { retained = validateDescriptions(await readJson(paths.descriptions)).items; } catch { /* No prior safe descriptions. */ }
    cache = { schemaVersion: 1, retryAt: null, entries: retained };
  }
  const entries = new Map(cache.entries.map(item => [normalizeTitle(item.title), { ...item }]));
  for (const title of [...titles, ...currentTitles].filter(validTitle)) {
    if (!entries.has(normalizeTitle(title))) entries.set(normalizeTitle(title), { title, entityId: null, description: null, fetchedAt: null });
  }
  const current = new Set(currentTitles.map(normalizeTitle));
  const pending = [...entries.values()].filter(item => item.fetchedAt === null
    || (current.has(normalizeTitle(item.title)) && now.getTime() - Date.parse(item.fetchedAt) >= DESCRIPTION_CACHE_MS))
    .sort((a, b) => Number(current.has(normalizeTitle(b.title))) - Number(current.has(normalizeTitle(a.title))));
  // Save pending titles before network access, so a failure cannot lose older editions' work.
  cache.entries = [...entries.values()];
  await atomicJson(paths.descriptionCache, cache);
  let requests = 0, changed = false;
  if (!cache.retryAt || Date.parse(cache.retryAt) <= now.getTime()) {
    for (let start = 0; start < pending.length && requests < DESCRIPTION_MAX_REQUESTS; start += DESCRIPTION_BATCH_SIZE) {
      const batch = pending.slice(start, start + DESCRIPTION_BATCH_SIZE).map(item => item.title);
      let retryAfter = null;
      try {
        await waitImpl(200);
        requests++;
        const response = await fetchImpl(descriptionRequestUrl(batch), { redirect: 'error',
          headers: { 'User-Agent': 'Sakranut/0.2 (https://github.com/HiliMor/sakranut) Node.js', Accept: 'application/json', 'Accept-Encoding': 'gzip,deflate' },
          signal: AbortSignal.timeout(12000) });
        retryAfter = response.headers.get('retry-after');
        if (!response.ok) { await response.body?.cancel(); throw new Error('Description request failed'); }
        const records = descriptionsFromResponse(await response.json(), batch, now.toISOString());
        for (const item of records) entries.set(normalizeTitle(item.title), item);
        cache.retryAt = null;
        changed = true;
      } catch {
        cache.retryAt = retryTime(retryAfter, now);
        logger.warn('Descriptions: optional lookup unavailable; cached identification retained, measurements unaffected.');
        break; // Includes API maxlag, 429 and Retry-After; no immediate retry storm.
      }
    }
  }
  cache.entries = [...entries.values()];
  await atomicJson(paths.descriptionCache, cache);
  const product = validateDescriptions({ schemaVersion: 1, generatedAt: now.toISOString(), source: { ...DESCRIPTION_SOURCE },
    items: cache.entries.filter(item => item.description !== null).map(({ title, entityId, description, fetchedAt }) => ({ title, entityId, description, fetchedAt })) });
  let previous = null;
  try { previous = validateDescriptions(await readJson(paths.descriptions)); } catch { /* Publish safe available records. */ }
  if (!previous || changed || JSON.stringify(previous.items) !== JSON.stringify(product.items)) await atomicJson(paths.descriptions, product);
  return { requests, described: product.items.length, pending: cache.entries.filter(item => item.fetchedAt === null).length };
}
