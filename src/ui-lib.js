import { articleSeriesUrl, BASELINE_DAYS, calculateMetrics, DISPLAY_DAYS, MIN_BASELINE, PROJECT, shiftDate, topUrl, windowFor } from '../data-lib.mjs';

export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const number = value => new Intl.NumberFormat('he-IL', { maximumFractionDigits: 1 }).format(value);
export const ratioLabel = value => value == null ? 'ללא בסיס מספיק' : `פי ${new Intl.NumberFormat('he-IL', { maximumFractionDigits: 1 }).format(value)}`;
export const dateLabel = (date, options = {}) => new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', timeZone: 'UTC', ...options }).format(new Date(`${date}T12:00:00Z`));
export const trendNames = { rising:'זינוק חדש', sustained:'עניין מתמשך', cooling:'ירידה מהשיא', steady:'ללא זינוק מזוהה', insufficient:'בסיס נמוך' };

export function validateSnapshot(data) {
  const finite = x => Number.isFinite(x) && x >= 0;
  const count = x => Number.isSafeInteger(x) && x >= 0;
  const text = x => typeof x === 'string' && x.trim().length > 0;
  const validDate = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString().slice(0,10) === x;
  const trustedUrl = (value, host) => {
    if (typeof value !== 'string' || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid source URL');
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid source URL'); }
    if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port || url.search || url.hash) throw new Error('Unapproved source URL');
    return url;
  };
  const matchingArticlePath = (url, expected) => {
    try { return decodeURIComponent(url.pathname).replaceAll('_', ' ') === decodeURIComponent(new URL(expected).pathname).replaceAll('_', ' '); }
    catch { return false; }
  };
  if (data?.schemaVersion !== 1 || !validDate(data.dataDate) || !validDate(data.seriesStart) || !validDate(data.baselineStart) || !validDate(data.baselineEnd) || typeof data.generatedAt !== 'string' || !Number.isFinite(Date.parse(data.generatedAt)) || !Array.isArray(data.articles) || !data.articles.length) throw new Error('Invalid snapshot metadata');
  if (Object.hasOwn(data, 'collectionOrigin') && !['scheduled', 'retrospective'].includes(data.collectionOrigin)) throw new Error('Invalid collection origin');
  const expectedWindow = windowFor(data.dataDate);
  if (['seriesStart', 'baselineStart', 'baselineEnd'].some(key => data[key] !== expectedWindow[key]) || Date.parse(data.generatedAt) < Date.parse(data.dataDate) + 86400000) throw new Error('Invalid snapshot date window');
  const source = data.source;
  if (source?.name !== 'Wikimedia Analytics API' || source.license !== 'CC0 1.0') throw new Error('Invalid snapshot source');
  trustedUrl(source.url, 'doc.wikimedia.org');
  trustedUrl(source.policyUrl, 'doc.wikimedia.org');
  if (trustedUrl(source.licenseUrl, 'creativecommons.org').href !== 'https://creativecommons.org/publicdomain/zero/1.0/' || trustedUrl(source.topUrl, 'wikimedia.org').href !== topUrl(data.dataDate)) throw new Error('Mismatched source metadata');
  const method = data.method;
  if (method?.project !== PROJECT || method.access !== 'all-access' || method.agent !== 'user' || method.baselineDays !== BASELINE_DAYS || method.displayDays !== DISPLAY_DAYS || method.minimumBaseline !== MIN_BASELINE || method.timezone !== 'UTC') throw new Error('Invalid snapshot method');
  if (['candidateSelection', 'exclusions', 'baseline', 'missingData', 'ratio', 'excess', 'elevated', 'activeDays'].some(key => !text(method[key])) || Object.keys(trendNames).some(key => !text(method.trends?.[key])) || !Array.isArray(method.limitations) || !method.limitations.length || !method.limitations.every(text)) throw new Error('Incomplete snapshot method');
  const coverage = data.coverage;
  if (!coverage || !validDate(coverage.requestedDate) || !count(coverage.fallbackDays) || coverage.fallbackDays > 3 || Date.parse(coverage.requestedDate) - Date.parse(data.dataDate) !== coverage.fallbackDays * 86400000 || !count(coverage.topListCount) || !count(coverage.candidateCount) || coverage.candidateCount < 1 || coverage.candidateCount > 30 || coverage.topListCount < coverage.candidateCount || coverage.articleCount !== data.articles.length || !Array.isArray(coverage.failures) || coverage.articleCount + coverage.failures.length !== coverage.candidateCount || coverage.articleCount < Math.ceil(coverage.candidateCount * .75)) throw new Error('Invalid snapshot coverage');
  const titles = new Set();
  for (const a of data.articles) {
    // Wikimedia may assign the same rank to titles tied on pageviews.
    if (!a || !text(a.title) || titles.has(a.title) || !count(a.rank) || a.rank < 1 || a.rank > coverage.topListCount || !count(a.views) || !finite(a.baseline) || !finite(a.excess) || (a.ratio !== null && !finite(a.ratio)) || (a.activeDays !== null && (!count(a.activeDays) || a.activeDays > DISPLAY_DAYS)) || !Object.hasOwn(trendNames, a.trend) || !Array.isArray(a.series) || a.series.length !== BASELINE_DAYS + DISPLAY_DAYS) throw new Error('Invalid article');
    titles.add(a.title);
    if (!matchingArticlePath(trustedUrl(a.url, 'he.wikipedia.org'), `https://he.wikipedia.org/wiki/${encodeURIComponent(a.title)}`) || !matchingArticlePath(trustedUrl(a.sourceUrl, 'wikimedia.org'), articleSeriesUrl(a.title, data.dataDate))) throw new Error('Mismatched article source');
    for (let i = 0; i < a.series.length; i++) {
      const point = a.series[i];
      if (!point || !validDate(point.date) || !count(point.views) || (i && Date.parse(point.date) - Date.parse(a.series[i - 1].date) !== 86400000)) throw new Error('Invalid timeline');
    }
    if (a.series.at(-1).date !== data.dataDate || a.series.at(-1).views !== a.views) throw new Error('Mismatched latest point');
    if (a.series[0].date !== data.baselineStart || a.series[27].date !== data.baselineEnd) throw new Error('Mismatched baseline dates');
    const metrics = calculateMetrics(a.series);
    if (['views', 'baseline', 'excess', 'activeDays', 'trend'].some(key => a[key] !== metrics[key]) || (metrics.ratio === null ? a.ratio !== null : a.ratio === null || Math.abs(a.ratio - metrics.ratio) > 0.00001)) throw new Error('Mismatched derived metrics');
  }
  for (const failure of coverage.failures) {
    if (!text(failure?.title) || !text(failure.error) || titles.has(failure.title)) throw new Error('Invalid excluded article');
    titles.add(failure.title);
  }
  // Additive v1 field: older last-good snapshots remain readable. Partial
  // observations may be displayed, but are never promoted into trend metrics.
  if (Object.hasOwn(data, 'uncomparedArticles')) {
    if (!Array.isArray(data.uncomparedArticles)) throw new Error('Invalid uncompared articles');
    const partialTitles = new Set();
    const expectedDates = Array.from({ length: BASELINE_DAYS + DISPLAY_DAYS }, (_, i) => shiftDate(data.seriesStart, i));
    for (const a of data.uncomparedArticles) {
      if (!a || !text(a.title) || partialTitles.has(a.title) || a.reason !== 'incomplete_history'
        || !count(a.rank) || a.rank < 1 || a.rank > coverage.topListCount
        || (a.views !== null && !count(a.views)) || !Array.isArray(a.series)
        || a.series.length < 1 || a.series.length >= expectedDates.length
        || !Array.isArray(a.missingDates)
        || ['baseline', 'ratio', 'excess', 'activeDays', 'trend'].some(key => Object.hasOwn(a, key))) throw new Error('Invalid uncompared article');
      partialTitles.add(a.title);
      if (!coverage.failures.some(f => f.title === a.title && f.error === 'Incomplete 35-day series')) throw new Error('Uncompared article must match an incomplete-series record');
      if (!matchingArticlePath(trustedUrl(a.url, 'he.wikipedia.org'), `https://he.wikipedia.org/wiki/${encodeURIComponent(a.title)}`)
        || !matchingArticlePath(trustedUrl(a.sourceUrl, 'wikimedia.org'), articleSeriesUrl(a.title, data.dataDate))) throw new Error('Mismatched uncompared article source');
      const observations = new Map();
      for (const [i, point] of a.series.entries()) {
        if (!point || !validDate(point.date) || !count(point.views)
          || point.date < data.seriesStart || point.date > data.dataDate
          || (i > 0 && point.date <= a.series[i - 1].date)) throw new Error('Invalid partial timeline');
        observations.set(point.date, point.views);
      }
      const missing = expectedDates.filter(date => !observations.has(date));
      if (a.missingDates.length !== missing.length || a.missingDates.some((date, i) => date !== missing[i])) throw new Error('Mismatched missing dates');
      if (a.views !== (observations.get(data.dataDate) ?? null)) throw new Error('Mismatched partial latest point');
    }
  }
  return data;
}

export function selectArticles(articles, sort = 'surge', query = '') {
  const filtered = articles.filter(a => a.title.replaceAll('_',' ').toLocaleLowerCase('he').includes(query.trim().toLocaleLowerCase('he')));
  if (sort === 'lasting') return filtered.filter(a => a.trend === 'sustained').sort((a, b) => b.activeDays - a.activeDays || b.views - a.views);
  if (sort === 'popular') return filtered.sort((a, b) => b.views - a.views);
  return filtered.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || b.views - a.views);
}

export function chartMarkup(article, compact = false, { inDetail = false } = {}) {
  const points = article.series.slice(-14);
  const width = compact ? 240 : 680, height = compact ? 58 : 230;
  // Full-size axes live in HTML so their text does not shrink with the SVG.
  const top = compact ? 6 : 0, bottom = compact ? 5 : 0, left = 3, right = compact ? 3 : 8;
  const max = Math.max(article.baseline, ...points.map(p => p.views), 1) * 1.1;
  const x = i => left + i * (width - left - right) / (points.length - 1);
  const y = v => height - bottom - v / max * (height - top - bottom);
  const path = points.map((p,i) => `${i ? 'L':'M'}${x(i).toFixed(2)},${y(p.views).toFixed(2)}`).join(' ');
  const area = `${path} L${x(points.length - 1)},${height-bottom} L${left},${height-bottom} Z`;
  const baselineY = y(article.baseline);
  const ticks = compact ? '' : [0, max/2, max].map(value => `<line class="chart-gridline" x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}"/>`).join('');
  const svg = `<svg class="${compact ? 'sparkline':'interest-chart'}" viewBox="0 0 ${width} ${height}" ${compact ? '' : 'preserveAspectRatio="none" '}aria-hidden="true" focusable="false">${ticks}<path class="chart-area" d="${area}"/><line class="baseline-line" x1="${left}" x2="${width-right}" y1="${baselineY}" y2="${baselineY}"/><path class="chart-path" d="${path}"/>${compact ? '' : `<circle class="chart-dot" cx="${x(points.length-1)}" cy="${y(points.at(-1).views)}" r="5"/>`}</svg>`;
  if (compact) return svg;
  const label = `צפיות יומיות בערך ${article.title} ב־14 הימים האחרונים. קו מקווקו מציין את רמת הבסיס ${number(article.baseline)}. ${inDetail ? 'טבלת 14 הימים מופיעה בהמשך חלון הפירוט.' : 'טבלת 14 הימים זמינה בכפתור הפירוט.'}`;
  const axes = [max, max / 2, 0].map(value => `<span>${number(max < 10 ? value : Math.round(value))}</span>`).join('');
  return `<div class="chart-frame" role="img" aria-label="${escapeHtml(label)}"><div class="chart-y-axis" aria-hidden="true">${axes}</div>${svg}</div>`;
}
