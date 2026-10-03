import { escapeHtml, dateLabel, validateSnapshot } from './ui-lib.js';

export const POLL_INTERVAL_MS = 60 * 60 * 1000;
export const STATUS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Clock tolerance is not tied to how frequently the browser checks for updates.
export const STATUS_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const CONTEXT_QUALIFICATION = 'הקשר אפשרי, לא סיבתיות מוכחת';
const DAY_MS = 86400000;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validTimestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
  && Number.isFinite(Date.parse(value));
const count = value => Number.isInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0;

export function validateStatus(value) {
  if (value?.schemaVersion !== 1 || value.mode !== 'scheduled'
    || !validTimestamp(value.checkedAt) || !validDate(value.targetDate)
    || (value.dataDate !== null && !validDate(value.dataDate))
    || (value.lastSuccessAt !== null && !validTimestamp(value.lastSuccessAt))
    || !['healthy', 'waiting', 'stale', 'error'].includes(value.state)
    || typeof value.message !== 'string'
    || !count(value.coverage?.candidateCount) || !count(value.coverage?.articleCount)
    || !count(value.coverage?.failuresCount) || typeof value.monitoring?.configured !== 'boolean'
    || value.coverage.articleCount > value.coverage.candidateCount
    || (value.lastSuccessAt !== null && Date.parse(value.lastSuccessAt) > Date.parse(value.checkedAt))) {
    throw new Error('Invalid collection status');
  }
  return value;
}

export function deriveLiveState(snapshot, status, now = Date.now(), statusUnavailable = false) {
  const ageDays = Math.floor((now - Date.parse(`${snapshot.dataDate}T00:00:00Z`)) / DAY_MS);
  const staleData = ageDays >= 3;
  const warnings = [];
  if (staleData) warnings.push(`נתוני המדידה ישנים: צילום המצב הוא מלפני ${ageDays} ימים. אין כאן נתונים בזמן אמת.`);
  if (!status) return {
    automated: false, staleData, checkedAt: null, warnings,
    label: staleData ? 'צילום מצב היסטורי' : statusUnavailable ? 'העדכון לא מאומת' : 'צילום מצב ידני',
    detail: statusUnavailable
      ? 'קובץ הנתונים זמין, אך סטטוס האיסוף לא זמין או לא תקין. הדף ינסה לבדוק אותו שוב.'
      : 'לא פורסם סטטוס של תהליך מתוזמן; הצילום מוצג כעדכון ידני, ללא אישור לאיסוף אוטומטי.'
  };
  const coherent = status.dataDate === snapshot.dataDate
    && status.coverage.articleCount === snapshot.articles.length
    && status.lastSuccessAt !== null
    && Date.parse(status.lastSuccessAt) >= Date.parse(snapshot.generatedAt)
    && Date.parse(status.checkedAt) >= Date.parse(status.lastSuccessAt)
    && Date.parse(status.checkedAt) <= now + STATUS_MAX_FUTURE_SKEW_MS;
  const freshStatus = now - Date.parse(status.checkedAt) <= STATUS_MAX_AGE_MS;
  if (!coherent) warnings.push('סטטוס האיסוף אינו תואם לקובץ הנתונים. לא ניתן לאשר כרגע שהצילום המוצג מתעדכן אוטומטית.');
  if (!freshStatus) warnings.push('לא התקבל אישור איסוף עדכני ב־6 השעות האחרונות. ייתכן שתהליך העדכון נעצר.');
  if (status.state === 'error') warnings.push('האיסוף האחרון דיווח על תקלה. מוצג צילום המצב התקין האחרון.');
  if (status.state === 'stale' && !staleData) warnings.push('השרת מדווח שנתוני המדידה אינם עדכניים.');
  if (!status.monitoring.configured) warnings.push('טרם הוגדר ניטור חיצוני: תקלה אינה מבטיחה שתישלח התראה.');
  return {
    automated: coherent && freshStatus,
    staleData,
    checkedAt: status.checkedAt,
    warnings,
    label: coherent && freshStatus
      ? `עדכון יומי אוטומטי${staleData || ['stale', 'error'].includes(status.state) ? ' · דורש בדיקה' : ''}`
      : 'העדכון האוטומטי לא מאומת',
    detail: status.state === 'waiting'
      ? 'ממתינים לפרסום נתוני היום הבא בוויקימדיה. בינתיים מוצג צילום המצב התקין האחרון.'
      : coherent && freshStatus && status.state === 'healthy'
        ? 'האיסוף המתוזמן בשרת פעיל; זמינות הנתונים תלויה במועד פרסומם בוויקימדיה.'
        : 'מוצג צילום המצב האחרון שאומת. פרטי התקלה או העיכוב מופיעים מעל הנתונים.'
  };
}

export function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function validateContexts(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.items)) throw new Error('Invalid context file');
  const seen = new Set();
  const items = [];
  for (const item of value.items) {
    if (!item || item.reviewStatus !== 'approved' || !text(item.title) || !validDate(item.dataDate)
      || !validTimestamp(item.reviewedAt) || !text(item.summary)
      || item.qualification !== CONTEXT_QUALIFICATION
      || !Array.isArray(item.sources) || !item.sources.length
      || item.sources.some(source => !source || !text(source.label) || !safeSourceUrl(source.url) || !validDate(source.publishedDate))) continue;
    const key = JSON.stringify([item.title, item.dataDate]);
    if (seen.has(key)) throw new Error('Duplicate approved context');
    seen.add(key);
    items.push({
      title: item.title, dataDate: item.dataDate, reviewStatus: 'approved', reviewedAt: item.reviewedAt,
      summary: item.summary, qualification: CONTEXT_QUALIFICATION,
      sources: item.sources.map(source => ({ label: source.label, url: safeSourceUrl(source.url), publishedDate: source.publishedDate }))
    });
  }
  return { schemaVersion: 1, items };
}

export function contextFor(contexts, title, dataDate) {
  return contexts?.items.find(item => item.reviewStatus === 'approved' && item.title === title && item.dataDate === dataDate) ?? null;
}

export function contextMarkup(context) {
  if (!context) return '<p class="context-empty">לא נוסף עדיין הסבר בדוק לזינוק הזה. המספרים לבדם אינם מעידים על הסיבה.</p>';
  return `<aside class="context-card" aria-label="הקשר אפשרי לזינוק"><p class="context-label">מה עשוי להסביר את הזינוק?</p><p class="context-summary">${escapeHtml(context.summary)}</p><p class="context-qualification">${escapeHtml(CONTEXT_QUALIFICATION)}</p><ul class="context-sources">${context.sources.map(source => `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)} ↗</a><span>פורסם ${dateLabel(source.publishedDate, { year: 'numeric' })}</span></li>`).join('')}</ul><p class="context-review">הסבר שאושר לפרסום · מתייחס לנתוני ${dateLabel(context.dataDate, { year: 'numeric' })}</p></aside>`;
}

export async function fetchJson(url, { fetchImpl = globalThis.fetch, optional = false, timeoutMs = 15000, cacheMode = 'no-store' } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { cache: cacheMode, signal: controller.signal });
    if (optional && response.status === 404) return null;
    // Vite's development fallback serves index.html for a missing public JSON file.
    if (optional && response.headers?.get('content-type')?.includes('text/html')) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

export async function loadLiveData({ baseUrl, previousSnapshot = null, previousContexts = null, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const results = await Promise.allSettled([
    fetchJson(new URL('data/snapshot.json', baseUrl), { fetchImpl, timeoutMs }).then(validateSnapshot),
    fetchJson(new URL('data/status.json', baseUrl), { fetchImpl, timeoutMs, optional: true }).then(value => value === null ? null : validateStatus(value)),
    fetchJson(new URL('data/context.json', baseUrl), { fetchImpl, timeoutMs, optional: true }).then(value => value === null ? null : validateContexts(value))
  ]);
  const [measurement, runtime, context] = results;
  // A delayed response or partial deployment must not move an open page backwards.
  const rollback = measurement.status === 'fulfilled' && previousSnapshot
    && (measurement.value.dataDate < previousSnapshot.dataDate
      || (measurement.value.dataDate === previousSnapshot.dataDate && Date.parse(measurement.value.generatedAt) < Date.parse(previousSnapshot.generatedAt)));
  return {
    snapshot: measurement.status === 'fulfilled' && !rollback ? measurement.value : previousSnapshot,
    status: runtime.status === 'fulfilled' ? runtime.value : null,
    contexts: context.status === 'fulfilled' ? context.value : previousContexts,
    snapshotError: rollback ? new Error('Snapshot regression refused') : measurement.status === 'rejected' ? measurement.reason : null,
    statusError: runtime.status === 'rejected' ? runtime.reason : null,
    contextError: context.status === 'rejected' ? context.reason : null
  };
}

export function snapshotDisplayKey(snapshot) {
  return JSON.stringify([snapshot.dataDate, snapshot.seriesStart, snapshot.baselineStart, snapshot.baselineEnd, snapshot.articles, snapshot.uncomparedArticles ?? [], snapshot.coverage]);
}
