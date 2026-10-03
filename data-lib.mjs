export const API_BASE = 'https://wikimedia.org/api/rest_v1/metrics/pageviews';
export const PROJECT = 'he.wikipedia.org';
export const BASELINE_DAYS = 28;
export const DISPLAY_DAYS = 7;
export const MIN_BASELINE = 20;

export function retryDelayMs(retryAfter, { now = Date.now(), attempt = 0 } = {}) {
  const value = typeof retryAfter === 'string' ? retryAfter.trim() : '';
  let requestedDelay = Number.NaN;
  if (/^\d+$/.test(value)) requestedDelay = Number(value) * 1000;
  else if (value) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) requestedDelay = Math.max(0, timestamp - now);
  }
  if (requestedDelay > 60_000) {
    const error = new Error('Publisher requested a retry after more than 60 seconds; stopping collection and preserving the existing snapshot.');
    error.code = 'STOP_COLLECTION';
    throw error;
  }
  return Math.max(1000, Number.isFinite(requestedDelay) ? requestedDelay : 2 ** attempt * 1000);
}

export function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid ISO date: ${value}`);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return date;
}

export function shiftDate(value, days) {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function windowFor(dataDate) {
  parseDate(dataDate);
  return {
    seriesStart: shiftDate(dataDate, -(BASELINE_DAYS + DISPLAY_DAYS - 1)),
    baselineStart: shiftDate(dataDate, -(BASELINE_DAYS + DISPLAY_DAYS - 1)),
    baselineEnd: shiftDate(dataDate, -DISPLAY_DAYS),
    displayStart: shiftDate(dataDate, -(DISPLAY_DAYS - 1)),
  };
}

export function median(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Median requires non-negative finite observations');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

// This conservative title filter excludes namespace-prefixed titles, but also
// any mainspace title containing a colon. It is a sample rule, not an ns lookup.
export function isEligibleTitle(title) {
  return typeof title === 'string' && title.trim().length > 0 &&
    !title.includes(':') && !['עמוד_ראשי', 'עמוד ראשי', 'Main_Page', '-'].includes(title);
}

export function selectCandidates(topArticles, limit = 30) {
  const seen = new Set();
  return topArticles.filter(article => {
    if (!isEligibleTitle(article.article) || seen.has(article.article)) return false;
    seen.add(article.article);
    return true;
  }).slice(0, limit);
}

export function topUrl(dataDate) {
  parseDate(dataDate);
  return `${API_BASE}/top/${PROJECT}/all-access/${dataDate.replaceAll('-', '/')}`;
}

export function articleSeriesUrl(title, dataDate) {
  const { seriesStart } = windowFor(dataDate);
  return articleRangeUrl(title, seriesStart, dataDate);
}

export function articleRangeUrl(title, startDate, endDate) {
  parseDate(startDate); parseDate(endDate);
  if (startDate > endDate) throw new Error('Invalid series range');
  const timestamp = value => `${value.replaceAll('-', '')}00`;
  return `${API_BASE}/per-article/${PROJECT}/all-access/user/${encodeURIComponent(title)}/daily/${timestamp(startDate)}/${timestamp(endDate)}`;
}

// Validate measured observations under the same rules for both comparable
// and incomplete histories. Missing dates are absence, never observed zeros.
export function parseDailySeries(items, dataDate) {
  const { seriesStart } = windowFor(dataDate);
  if (!Array.isArray(items) || !items.length) throw new Error('Missing per-article daily observations');
  const observations = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid daily observation');
    const stamp = typeof item.timestamp === 'string' || Number.isSafeInteger(item.timestamp) ? String(item.timestamp) : '';
    if (!/^\d{8}00$/.test(stamp)) throw new Error('Invalid daily timestamp');
    const date = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
    parseDate(date);
    if (date < seriesStart || date > dataDate) throw new Error(`Daily observation outside requested window: ${date}`);
    if (!Number.isSafeInteger(item.views) || item.views < 0) throw new Error(`Invalid views on ${date}`);
    if (observations.has(date)) throw new Error(`Duplicate observation on ${date}`);
    observations.set(date, item.views);
  }
  const series = [], missingDates = [];
  for (let index = 0; index < BASELINE_DAYS + DISPLAY_DAYS; index += 1) {
    const date = shiftDate(seriesStart, index);
    if (observations.has(date)) series.push({ date, views: observations.get(date) });
    else missingDates.push(date);
  }
  return { series, missingDates };
}

export function normalizeSeries(items, dataDate) {
  const { series, missingDates } = parseDailySeries(items, dataDate);
  if (missingDates.length) {
    const error = new Error(`Missing daily observation: ${missingDates[0]}`);
    error.code = 'INCOMPLETE_HISTORY';
    throw error;
  }
  return series;
}

export function calculateMetrics(series) {
  if (series.length !== BASELINE_DAYS + DISPLAY_DAYS) throw new Error('Expected exactly 35 daily observations');
  if (series.some(day => !Number.isSafeInteger(day.views) || day.views < 0)) throw new Error('Invalid daily views');
  const baseline = median(series.slice(0, BASELINE_DAYS).map(day => day.views));
  const displayed = series.slice(BASELINE_DAYS);
  const views = displayed.at(-1).views;
  const excess = Math.max(0, views - baseline);
  if (baseline < MIN_BASELINE) {
    return { views, baseline, ratio: null, excess, activeDays: null, trend: 'insufficient' };
  }
  const threshold = Math.max(2 * baseline, 100);
  let activeDays = 0;
  for (let index = displayed.length - 1; index >= 0 && displayed[index].views >= threshold; index -= 1) activeDays += 1;
  const previousPeak = Math.max(...displayed.slice(0, -1).map(day => day.views));
  const cooling = previousPeak >= threshold && views < previousPeak * 0.6;
  const trend = cooling ? 'cooling' : activeDays >= 3 ? 'sustained' : activeDays > 0 ? 'rising' : 'steady';
  return { views, baseline, ratio: views / baseline, excess, activeDays, trend };
}

export function buildArticle(candidate, items, dataDate) {
  const series = normalizeSeries(items, dataDate);
  return {
    title: candidate.article.replaceAll('_', ' '),
    url: `https://he.wikipedia.org/wiki/${encodeURIComponent(candidate.article)}`,
    sourceUrl: articleSeriesUrl(candidate.article, dataDate),
    rank: candidate.rank,
    ...calculateMetrics(series),
    series,
  };
}

export function buildUncomparedArticle(candidate, items, dataDate) {
  const { series, missingDates } = parseDailySeries(items, dataDate);
  if (!missingDates.length) throw new Error('Expected incomplete daily history');
  return {
    title: candidate.article.replaceAll('_', ' '),
    url: `https://he.wikipedia.org/wiki/${encodeURIComponent(candidate.article)}`,
    sourceUrl: articleSeriesUrl(candidate.article, dataDate),
    rank: candidate.rank,
    reason: 'incomplete_history',
    views: series.find(day => day.date === dataDate)?.views ?? null,
    series,
    missingDates,
  };
}

export const METHOD = {
  project: PROJECT,
  access: 'all-access',
  agent: 'user',
  candidateSelection: 'First 30 eligible titles in the daily top list, in its original rank order. This is not an all-Wikipedia spike search.',
  exclusions: 'Exclude the main page, the technical title "-", and all titles containing a colon (namespace-prefixed pages plus some valid mainspace titles).',
  baseline: 'Median of the first 28 daily observations, strictly before the displayed final 7 days. The baseline is fixed for all displayed days.',
  baselineDays: BASELINE_DAYS,
  displayDays: DISPLAY_DAYS,
  minimumBaseline: MIN_BASELINE,
  missingData: 'Require all 35 daily observations for comparison metrics. Valid incomplete histories are shown separately in uncomparedArticles with measured counts and explicit missing dates, without baseline, ratio, trend or streak metrics; they remain comparison failures in coverage. Unavailable or malformed series are not shown. Observed zero is valid; missing is never zero-filled.',
  ratio: 'Final-day user pageviews / fixed baseline. Null when baseline < 20; no floor, pseudocount or fabricated ratio.',
  excess: 'max(0, final-day user pageviews - fixed baseline).',
  elevated: 'At least twice the fixed baseline AND at least 100 daily views.',
  activeDays: 'Consecutive elevated days ending on dataDate within the displayed 7 days; capped at 7. Null for insufficient baseline.',
  trends: {
    insufficient: 'Baseline < 20.',
    cooling: 'A preceding displayed day was elevated, and final-day views are below 60% of that prior six-day peak. Takes precedence over sustained.',
    sustained: 'At least 3 consecutive elevated displayed days ending on dataDate.',
    rising: 'Final day is elevated, with only 1 or 2 consecutive elevated displayed days; denotes newly elevated interest, not a guaranteed day-over-day increase.',
    steady: 'None of the above; this does not establish statistical stability.',
  },
  timezone: 'UTC',
  limitations: [
    'Pageviews are not unique people. The user agent category excludes recognized bots, not all automated or anomalous traffic.',
    'Hebrew Wikipedia readership is not a representative sample of the Israeli population.',
    'Top-list selection omits many lower-volume spikes. Labels are descriptive heuristics, not significance tests or causal explanations.',
    'Article titles are measured independently; redirects, renamed pages and related titles are not merged.',
    'An incomplete history does not establish that an article is new or explain why observations are absent.',
    'A fixed 28-day median is not a model of weekly or seasonal patterns.',
    'The snapshot covers a completed UTC day; collection can run on a schedule, but this is not a real-time feed.',
  ],
};
