import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { parseDate, shiftDate } from '../data-lib.mjs';
import { validateSnapshot } from './ui-lib.js';

const text = (value, max = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const date = value => { try { return typeof value === 'string' && Boolean(parseDate(value)); } catch { return false; } };
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === (value.length === 20 ? value.replace('Z', '.000Z') : value);
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const queriesFor = (title, dataDate) => {
  const literal = title.replaceAll('"', ' ').replaceAll('\\', ' ').trim();
  return [`"${literal}" ${dataDate}`, `"${literal}" חדשות`];
};
const queueBody = queue => ({
  schemaVersion: 1, kind: 'context_research_queue', dataDate: queue.dataDate,
  snapshotGeneratedAt: queue.snapshotGeneratedAt,
  items: queue.items.map(item => ({
    title: item.title, dataDate: item.dataDate, views: item.views, baseline: item.baseline, ratio: item.ratio,
    dateWindow: { from: item.dateWindow.from, to: item.dateWindow.to },
    searchQueries: item.searchQueries, researchStatus: item.researchStatus,
  })),
});
const queueIdFor = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');

/** A deterministic work list, not explanations, a worker, or a publishing feed. */
export function buildResearchQueue(snapshot) {
  validateSnapshot(snapshot);
  const items = snapshot.articles.filter(article => ['rising', 'sustained'].includes(article.trend)
    && article.views >= 100 && article.ratio !== null && article.ratio >= 2)
    .sort((a, b) => b.ratio - a.ratio || b.views - a.views || a.rank - b.rank || a.title.localeCompare(b.title, 'he'))
    .slice(0, 5).map(article => ({
      title: article.title, dataDate: snapshot.dataDate,
      views: article.views, baseline: article.baseline, ratio: article.ratio,
      dateWindow: { from: shiftDate(snapshot.dataDate, -2), to: snapshot.dataDate },
      searchQueries: queriesFor(article.title, snapshot.dataDate), researchStatus: 'pending',
    }));
  const body = queueBody({ dataDate: snapshot.dataDate, snapshotGeneratedAt: snapshot.generatedAt, items });
  return validateResearchQueue({ ...body, queueId: queueIdFor(body) });
}

export function validateResearchQueue(queue) {
  if (!keys(queue, ['schemaVersion', 'kind', 'dataDate', 'snapshotGeneratedAt', 'items', 'queueId'])
    || queue.schemaVersion !== 1 || queue.kind !== 'context_research_queue'
    || !date(queue.dataDate) || !timestamp(queue.snapshotGeneratedAt)
    || Date.parse(queue.snapshotGeneratedAt) < Date.parse(queue.dataDate) + 86400000
    || !Array.isArray(queue.items) || queue.items.length > 5
    || typeof queue.queueId !== 'string' || !/^[a-f0-9]{64}$/.test(queue.queueId)) throw new Error('Invalid research queue');
  const seen = new Set();
  for (const item of queue.items) {
    if (!keys(item, ['title', 'dataDate', 'views', 'baseline', 'ratio', 'dateWindow', 'searchQueries', 'researchStatus'])
      || !text(item.title) || seen.has(item.title) || item.dataDate !== queue.dataDate || item.researchStatus !== 'pending'
      || !Number.isSafeInteger(item.views) || item.views < 100
      || !Number.isFinite(item.baseline) || item.baseline < 20 || !Number.isFinite(item.ratio) || item.ratio < 2
      || Math.abs(item.ratio - item.views / item.baseline) > 0.00001
      || !keys(item.dateWindow, ['from', 'to']) || item.dateWindow.from !== shiftDate(queue.dataDate, -2) || item.dateWindow.to !== queue.dataDate
      || JSON.stringify(item.searchQueries) !== JSON.stringify(queriesFor(item.title, queue.dataDate))) throw new Error('Invalid research queue item');
    seen.add(item.title);
  }
  if (queue.queueId !== queueIdFor(queueBody(queue))) throw new Error('Research queue identity mismatch');
  return queue;
}

/** Lexical safety only: no network request, DNS resolution or redirect/body verification. */
export function safeResearchSourceUrl(value) {
  if (typeof value !== 'string' || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(host) || !host.includes('.')
      || host.length > 253 || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|localdomain|onion)$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}

/**
 * Validate operator-recorded research, not its factual truth. Even a full-text
 * candidate remains a draft requiring independent review; no approved UI shape
 * or automatic promotion is produced here. Unknown evidence supports abstention.
 */
export function validateDrafts(drafts, queue) {
  validateResearchQueue(queue);
  if (!keys(drafts, ['schemaVersion', 'kind', 'queueId', 'dataDate', 'reviewStatus', 'items'])
    || drafts.schemaVersion !== 1 || drafts.kind !== 'context_research_drafts'
    || drafts.queueId !== queue.queueId || drafts.dataDate !== queue.dataDate || drafts.reviewStatus !== 'draft'
    || !Array.isArray(drafts.items) || drafts.items.length > queue.items.length) throw new Error('Invalid draft envelope; only matching draft research is accepted');
  const seen = new Set();
  for (const item of drafts.items) {
    const queued = queue.items.find(candidate => candidate.title === item?.title);
    if (!keys(item, ['title', 'dataDate', 'reviewStatus', 'verdict', 'summary', 'sources', 'reviewNotes'])
      || !queued || seen.has(item.title) || item.dataDate !== queue.dataDate || item.reviewStatus !== 'draft'
      || !['candidate', 'abstain'].includes(item.verdict) || !text(item.reviewNotes, 2000)
      || (Object.hasOwn(item, 'summary') && !text(item.summary, 600))
      || (item.verdict === 'candidate' && !text(item.summary, 600))
      || !Array.isArray(item.sources) || item.sources.length > 3) throw new Error('Invalid draft item; approved or unmatched research is not accepted');
    seen.add(item.title);
    const urls = new Set();
    let hasDatedFullText = false;
    for (const source of item.sources) {
      if (!keys(source, ['url', 'title', 'publishedDate', 'sourceReadAt', 'evidenceBasis', 'eventDate'])
        || !text(source.title) || !safeResearchSourceUrl(source.url)
        || (source.publishedDate !== null && !date(source.publishedDate))
        || (source.sourceReadAt !== null && !timestamp(source.sourceReadAt))
        || !['full-text', 'snippet'].includes(source.evidenceBasis)
        || (source.evidenceBasis === 'full-text' && source.sourceReadAt === null)
        || (Object.hasOwn(source, 'eventDate') && source.eventDate !== null && !date(source.eventDate))) throw new Error('Invalid draft source');
      const canonicalUrl = safeResearchSourceUrl(source.url);
      if (urls.has(canonicalUrl)) throw new Error('Duplicate draft source');
      urls.add(canonicalUrl);
      if (source.sourceReadAt !== null && source.publishedDate !== null && source.sourceReadAt.slice(0, 10) < source.publishedDate) throw new Error('Source cannot be read before its recorded publication date');
      if (source.evidenceBasis === 'full-text' && source.publishedDate !== null
        && source.publishedDate >= queued.dateWindow.from && source.publishedDate <= queued.dateWindow.to) hasDatedFullText = true;
    }
    if (item.verdict === 'candidate' && !hasDatedFullText) throw new Error('A candidate needs dated full-text evidence in the queue window; otherwise abstain');
  }
  return drafts;
}
