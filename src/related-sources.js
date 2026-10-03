import { parseDate, shiftDate } from '../data-lib.mjs';
import { safeResearchSourceUrl, validateResearchQueue } from './context-pilot-lib.js';
import { normalizeText } from './related-coverage-lib.js';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const ENDPOINTS = { hebcal: 'https://www.hebcal.com/hebcal', gdelt: 'https://api.gdeltproject.org/api/v2/doc/doc' };
const ATTRIBUTION = { hebcal: 'Hebcal (CC BY 4.0)', gdelt: 'GDELT Project (https://www.gdeltproject.org/)' };

// Discovery-only aliases for the bounded five-title pilot, not entity resolution.
// GDELT's own multilingual index uses upstream machine translation. This adapter
// does not call a model and does not claim the upstream pipeline is AI-free.
const DISCOVERY_ALIASES = new Map([
  ['יעקב עמידרור', 'Amidror'], ['הושענא רבה', '"Hoshana Rabbah"'],
  ['תעתוע (סרט)', 'Verity'], ['קוסובו', 'Kosovo'], ['סאמי אבו שחאדה', '"Abu Shehadeh"'],
]);
// Reviewed provider label for the current pilot; exact normalized equality only.
// A phrase embedded in a different holiday (e.g. Pesach Sheni) is not a match.
const CALENDAR_ALIASES = new Map([
  ['הושענא רבה', ['הושענא רבה', 'סוכות ז׳ (הושענא רבה)']],
]);

const text = (value, max = 1000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validDate = value => { try { return typeof value === 'string' && Boolean(parseDate(value)); } catch { return false; } };
const bad = code => Object.assign(new Error(code), { sourceCode: code });

function requestUrl(sourceId, queue) {
  const url = new URL(ENDPOINTS[sourceId]);
  const start = shiftDate(queue.dataDate, -2), end = shiftDate(queue.dataDate, 1);
  if (sourceId === 'hebcal') {
    url.search = new URLSearchParams({ v: '1', cfg: 'json', start, end, maj: 'on', i: 'on', lg: 'he' }).toString();
  } else {
    const aliases = [...new Set(queue.items.map(item => DISCOVERY_ALIASES.get(item.title)).filter(Boolean))];
    if (!aliases.length) return null;
    url.search = new URLSearchParams({
      query: `(${aliases.join(' OR ')}) sourcelang:hebrew`, mode: 'artlist', format: 'json', maxrecords: '100',
      startdatetime: start.replaceAll('-', '') + '000000', enddatetime: end.replaceAll('-', '') + '000000',
    }).toString();
  }
  return url.href;
}

/** One request, bounded through body completion; never retry or follow a link. */
async function fetchJsonBounded(sourceId, url, fetchImpl) {
  const expected = new URL(ENDPOINTS[sourceId]), actual = new URL(url);
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) throw bad('endpoint_not_allowed');
  const controller = new AbortController();
  let timedOut = false, response, reader;
  const timeout = new Promise((_, reject) => {
    const handle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(bad('timeout'));
    }, TIMEOUT_MS);
    controller.signal.addEventListener('abort', () => clearTimeout(handle), { once: true });
  });
  const task = (async () => {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
    if (!response.ok) throw bad('http_error');
    if (response.redirected) throw bad('redirect_not_allowed');
    const declaredSize = Number(response.headers?.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_BYTES) throw bad('response_too_large');
    if (!response.body || typeof response.body.getReader !== 'function') throw bad('invalid_body');
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw bad('invalid_body');
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw bad('response_too_large');
      chunks.push(value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
    catch { throw bad('invalid_json'); }
  })();
  try { return { payload: await Promise.race([task, timeout]), httpStatus: response.status }; }
  catch (error) {
    // Provider messages, URLs from thrown errors, and bodies are not diagnostics.
    return { errorCode: timedOut ? 'timeout' : error.sourceCode || 'request_failed', ...(response ? { httpStatus: response.status } : {}) };
  } finally {
    controller.abort();
    // Do not wait on a misbehaving body to cancel: the timeout includes cleanup.
    if (reader) { void reader.cancel().catch(() => {}); }
    else if (response?.body) { void response.body.cancel().catch(() => {}); }
  }
}

function calendarRecords(payload, queue) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) throw bad('invalid_shape');
  let invalidRecordCount = 0, recordCount = 0;
  const calendarItems = [], seen = new Set();
  const from = shiftDate(queue.dataDate, -2), until = shiftDate(queue.dataDate, 1);
  for (const item of payload.items) {
    let link;
    try { link = new URL(item?.link); } catch { /* rejected below */ }
    if (!item || !text(item.title) || !validDate(item.date) || !text(item.category, 100)
      || (item.hebrew !== undefined && !text(item.hebrew))
      || !link || !safeResearchSourceUrl(item.link) || link.protocol !== 'https:' || !['www.hebcal.com', 'hebcal.com'].includes(link.hostname)
      || link.username || link.password || link.port || item.date < from || item.date > until) {
      invalidRecordCount++;
      continue;
    }
    recordCount++;
    const distance = (parseDate(item.date) - parseDate(queue.dataDate)) / 86400000;
    if (Math.abs(distance) > 1 || item.category !== 'holiday') continue;
    for (const queued of queue.items) {
      const aliases = (CALENDAR_ALIASES.get(queued.title) ?? [queued.title]).map(normalizeText);
      const eventTitle = [item.hebrew, item.title].find(candidate => candidate && aliases.includes(normalizeText(candidate)));
      if (!eventTitle) continue;
      const key = JSON.stringify([queued.title, item.date, link.href]);
      if (seen.has(key)) continue;
      seen.add(key);
      calendarItems.push({
        title: queued.title, eventTitle, eventDate: item.date, url: link.href,
        relation: distance === 0 ? 'same_calendar_date' : distance < 0 ? 'previous_calendar_date' : 'next_calendar_date',
        sourceId: 'hebcal', calendar: 'Hebrew (Israel)', dateBasis: 'civil_date_no_sunset_time',
        attribution: ATTRIBUTION.hebcal, reviewStatus: 'draft',
      });
    }
  }
  return { recordCount, invalidRecordCount, calendarItems, records: [] };
}

function providerTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{8}T\d{6}Z$/.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString() === iso ? iso : null;
}

function discoveryRecords(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.articles)) throw bad('invalid_shape');
  const records = [];
  let invalidRecordCount = 0;
  for (const article of payload.articles) {
    const url = safeResearchSourceUrl(article?.url);
    const providerSeenAt = article?.seendate == null ? null : providerTimestamp(article.seendate);
    if (!article || !text(article.title, 500) || !url || (article.seendate != null && !providerSeenAt)) {
      invalidRecordCount++;
      continue;
    }
    records.push({ sourceId: 'gdelt', title: article.title, url, publishedDate: null, ...(providerSeenAt ? { providerSeenAt } : {}) });
  }
  return { records, calendarItems: [], recordCount: records.length, invalidRecordCount };
}

/** Metadata discovery only. No article fetch, summaries, inferred publication
 * dates, approvals, or writes. Caller decides how to preserve probe diagnostics. */
export async function probeRelatedSources(queue, { fetchImpl = fetch, now = () => new Date(), includeDiscovery = false } = {}) {
  validateResearchQueue(queue);
  const sources = [], records = [], calendarItems = [];
  for (const sourceId of ['hebcal', 'gdelt']) {
    const fetchedAt = now().toISOString();
    const base = { sourceId, fetchedAt, attribution: ATTRIBUTION[sourceId] };
    const url = sourceId === 'gdelt' && !includeDiscovery ? null : requestUrl(sourceId, queue);
    if (!url) {
      sources.push({ ...base, status: 'skipped', recordCount: 0, errorCode: includeDiscovery ? 'no_supported_aliases' : 'discovery_not_requested' });
      continue;
    }
    const fetched = await fetchJsonBounded(sourceId, url, fetchImpl);
    if (fetched.errorCode) {
      const invalid = ['invalid_json', 'invalid_body', 'response_too_large'].includes(fetched.errorCode);
      sources.push({ ...base, status: invalid ? 'invalid_response' : 'unavailable', recordCount: 0, requestUrl: url, ...fetched });
      continue;
    }
    try {
      const parsed = sourceId === 'hebcal' ? calendarRecords(fetched.payload, queue) : discoveryRecords(fetched.payload);
      const invalid = parsed.invalidRecordCount > 0 && parsed.recordCount === 0;
      sources.push({ ...base, status: invalid ? 'invalid_response' : 'ok', httpStatus: fetched.httpStatus, recordCount: parsed.recordCount, invalidRecordCount: parsed.invalidRecordCount, ...(invalid ? { errorCode: 'invalid_records' } : {}), requestUrl: url });
      records.push(...parsed.records);
      calendarItems.push(...parsed.calendarItems);
    } catch (error) {
      sources.push({ ...base, status: 'invalid_response', httpStatus: fetched.httpStatus, recordCount: 0, errorCode: error.sourceCode || 'invalid_shape', requestUrl: url });
    }
  }
  return { sources, records, calendarItems };
}
