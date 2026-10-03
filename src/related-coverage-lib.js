import { parseDate } from '../data-lib.mjs';
import { safeResearchSourceUrl, validateResearchQueue } from './context-pilot-lib.js';

const MAX_LINKS = 3;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const validDate = value => { try { return typeof value === 'string' && Boolean(parseDate(value)); } catch { return false; } };
const validTimestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

/** Token normalization only: no entity inference, Hebrew prefix stemming or NLP. */
export function normalizeText(value) {
  return typeof value === 'string' ? value.normalize('NFKD').replace(/\p{M}/gu, '')
    .toLocaleLowerCase('he').replace(/["'׳״‘’“”]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ') : '';
}

const containsPhrase = (haystack, phrase) => Boolean(phrase) && ` ${haystack} `.includes(` ${phrase} `);

function canonicalUrl(value) {
  const safe = safeResearchSourceUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  for (const name of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(name) || /^(?:fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid)$/i.test(name)) url.searchParams.delete(name);
  }
  url.hash = '';
  url.searchParams.sort();
  return url.href;
}

function ruleFor(title, entityRules) {
  const provided = Object.hasOwn(entityRules, title) ? entityRules[title] : {};
  if (!provided || typeof provided !== 'object' || Array.isArray(provided)
    || Object.keys(provided).some(key => !['aliases', 'requiredAny', 'disabled'].includes(key))
    || (provided.disabled !== undefined && typeof provided.disabled !== 'boolean')) throw new Error('Invalid entity rule');
  const normalizeList = (values, fallback) => {
    if (values === undefined) return fallback;
    if (!Array.isArray(values) || values.length > 20 || values.some(value => !text(value, 500) || !normalizeText(value))) throw new Error('Invalid entity rule phrases');
    return [...new Set(values.map(normalizeText))].sort(compare);
  };
  const aliases = normalizeList(provided.aliases, [normalizeText(title)]);
  const requiredAny = normalizeList(provided.requiredAny, []);
  if (!provided.disabled && !aliases.length) throw new Error('An enabled entity rule needs an alias');
  // A short alias for a longer entity must carry explicit disambiguation. The
  // default never derives a surname or individual token from the full title.
  if (!provided.disabled && normalizeText(title).includes(' ') && !requiredAny.length
    && aliases.some(alias => !alias.includes(' '))) throw new Error('Single-token aliases of multi-token titles need disambiguation');
  return { aliases, requiredAny, disabled: provided.disabled === true };
}

function preparedRecord(record) {
  const identity = record && typeof record === 'object' && !Array.isArray(record) ? {
    ...(typeof record.id === 'string' || Number.isSafeInteger(record.id) ? { recordId: String(record.id) } : {}),
    ...(text(record.sourceId, 100) ? { sourceId: record.sourceId } : {}),
    ...(text(record.title, 500) ? { title: record.title } : {}),
  } : {};
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !text(record.sourceId, 100) || !text(record.title, 500) || !normalizeText(record.title)
    || (record.id !== undefined && typeof record.id !== 'string' && !Number.isSafeInteger(record.id))
    || (record.text !== undefined && (typeof record.text !== 'string' || record.text.length > 1200))
    || (record.observedAt !== undefined && record.observedAt !== null && !validTimestamp(record.observedAt))) {
    return { identity, rejection: 'invalid_record', sortKey: JSON.stringify(identity) };
  }
  const url = canonicalUrl(record.url);
  return {
    identity, url, publishedDate: record.publishedDate,
    ...(record.observedAt ? { observedAt: record.observedAt } : {}),
    fields: [['title', normalizeText(record.title)], ['text', normalizeText(record.text)]],
    normalizedTitle: normalizeText(record.title),
    rejection: !url ? 'unsafe_url' : record.publishedDate == null ? 'unknown_date' : !validDate(record.publishedDate) ? 'invalid_date' : null,
    sortKey: JSON.stringify([url, record.sourceId, normalizeText(record.title), record.title, identity.recordId ?? '', record.observedAt ?? '', record.text ?? '']),
  };
}

/**
 * Pure metadata matching, not full-text research, source verification or a
 * causal explanation. No source bodies or model-generated summaries are output.
 */
export function matchRelatedCoverage(queue, records, entityRules = {}) {
  validateResearchQueue(queue);
  if (!Array.isArray(records) || !entityRules || typeof entityRules !== 'object' || Array.isArray(entityRules)) throw new Error('Invalid matching inputs');
  const prepared = records.map(preparedRecord).sort((a, b) =>
    compare(validDate(b.publishedDate) ? b.publishedDate : '', validDate(a.publishedDate) ? a.publishedDate : '') || compare(a.sortKey, b.sortKey));
  const items = queue.items.map(item => {
    const rule = ruleFor(item.title, entityRules);
    const links = [], rejections = [], seenUrls = new Set(), seenTitles = new Set();
    if (!rule.disabled) for (const record of prepared) {
      const reject = reason => rejections.push({ ...record.identity, reason });
      if (record.rejection) { reject(record.rejection); continue; }
      if (record.publishedDate > item.dateWindow.to) { reject('future_date'); continue; }
      if (record.publishedDate < item.dateWindow.from) { reject('outside_window'); continue; }
      let matchedAlias, matchedField;
      for (const [field, content] of record.fields) {
        const alias = rule.aliases.find(value => containsPhrase(content, value));
        if (alias) { matchedAlias = alias; matchedField = field; break; }
      }
      if (!matchedAlias) { reject('no_entity_match'); continue; }
      const matchedRequiredTerm = rule.requiredAny.find(term => record.fields.some(([, content]) => containsPhrase(content, term)));
      if (rule.requiredAny.length && !matchedRequiredTerm) { reject('ambiguous_entity'); continue; }
      if (seenUrls.has(record.url)) { reject('duplicate_url'); continue; }
      if (seenTitles.has(record.normalizedTitle)) { reject('duplicate_title'); continue; }
      seenUrls.add(record.url); seenTitles.add(record.normalizedTitle);
      if (links.length >= MAX_LINKS) { reject('link_limit'); continue; }
      links.push({
        ...record.identity, url: record.url, publishedDate: record.publishedDate,
        ...(record.observedAt ? { observedAt: record.observedAt } : {}),
        matchedAlias, matchedField, ...(matchedRequiredTerm ? { matchedRequiredTerm } : {}),
        reason: 'metadata_entity_and_date_window',
      });
    }
    return {
      title: item.title, dataDate: item.dataDate, reviewStatus: 'draft',
      state: rule.disabled ? 'disabled' : links.length ? 'matched' : 'no_match', links, rejections,
    };
  });
  return {
    schemaVersion: 1, kind: 'related_coverage_draft', queueId: queue.queueId, dataDate: queue.dataDate,
    reviewStatus: 'draft', published: false, evidenceBasis: 'metadata-only', causalInference: false,
    qualification: 'קישורים קשורים לפי כותרת או תקציר ותאריך; לא הסבר מוכח לסיבת הזינוק.', items,
  };
}
