import { articleSeriesUrl, calculateMetrics, shiftDate, windowFor } from '../data-lib.mjs';
import { validArchiveDate } from './archive-state.js';
import { normalizeTitle, validTitle, validRetrievedAt } from './identification.js';

export const TRACKING_DAYS = 30;

// Only measured observations and sample membership cross the runtime boundary.
// A missing observation, or absence from a top list, is never a measured zero.
export function validateTracks(value) {
  if (value?.schemaVersion !== 1 || !validArchiveDate(value.dataDate)
    || value.periodStart !== shiftDate(value.dataDate, -(TRACKING_DAYS - 1))
    || value.seriesStart !== windowFor(value.periodStart).seriesStart
    || !validRetrievedAt(value.generatedAt) || Date.parse(value.generatedAt) < Date.parse(value.dataDate) + 86400000
    || !Array.isArray(value.availableDates) || !value.availableDates.length
    || value.availableDates.at(-1) !== value.dataDate
    || !Array.isArray(value.items) || value.items.length > TRACKING_DAYS * 30) throw new Error('Invalid tracking product');
  const dates = new Set();
  for (const date of value.availableDates) {
    if (!validArchiveDate(date) || date < value.periodStart || date > value.dataDate || dates.has(date)
      || (dates.size && date <= [...dates].at(-1))) throw new Error('Invalid tracking dates');
    dates.add(date);
  }
  const seen = new Set();
  const items = value.items.map(item => {
    if (!validTitle(item?.title) || item.title !== normalizeTitle(item.title) || seen.has(item.title)
      || !Array.isArray(item.sampleDates) || !item.sampleDates.length || item.sampleDates.length > TRACKING_DAYS
      || !Array.isArray(item.series) || item.series.length > 64) throw new Error('Invalid tracked article');
    seen.add(item.title);
    for (const [i, date] of item.sampleDates.entries()) {
      if (!dates.has(date) || (i && date <= item.sampleDates[i - 1])) throw new Error('Invalid sample membership');
    }
    const series = item.series.map((point, i) => {
      if (!validArchiveDate(point?.date) || point.date < value.seriesStart || point.date > value.dataDate
        || !Number.isSafeInteger(point.views) || point.views < 0 || (i && point.date <= item.series[i - 1].date)) throw new Error('Invalid tracked observation');
      return { date: point.date, views: point.views };
    });
    return { title: item.title, sampleDates: [...item.sampleDates], series };
  });
  return { schemaVersion: 1, dataDate: value.dataDate, periodStart: value.periodStart, seriesStart: value.seriesStart,
    generatedAt: value.generatedAt, availableDates: [...value.availableDates], items };
}

export function trackedArticles(tracks, dataDate) {
  if (!tracks || !tracks.availableDates.includes(dataDate)) return [];
  const { seriesStart } = windowFor(dataDate);
  return tracks.items.flatMap(item => {
    // Do not leak a title discovered in the future into an older edition.
    const sampleDates = item.sampleDates.filter(date => date <= dataDate);
    if (!sampleDates.length) return [];
    const series = item.series.filter(point => point.date >= seriesStart && point.date <= dataDate);
    if (series.length !== 35 || series.some((point, i) => point.date !== shiftDate(seriesStart, i))) return [];
    return [{ title: item.title, url: `https://he.wikipedia.org/wiki/${encodeURIComponent(item.title)}`,
      sourceUrl: articleSeriesUrl(item.title, dataDate), series, ...calculateMetrics(series),
      tracked: true, lastSampleDate: sampleDates.at(-1), firstSampleDate: sampleDates[0] }];
  });
}

export function weeklyPatterns(tracks, dataDate, { limit = 3 } = {}) {
  const articles = trackedArticles(tracks, dataDate).filter(article => article.baseline >= 20);
  const persistent = [], cooled = [];
  for (const article of articles) {
    const recent = article.series.slice(-7), threshold = Math.max(2 * article.baseline, 100);
    const score = recent.reduce((sum, point) => sum + Math.max(0, point.views - article.baseline), 0);
    if (article.activeDays >= 3) persistent.push({ ...article, kind: 'persistent', score });
    const peak = recent.reduce((best, point, i) => point.views > best.views ? { ...point, index: i } : best, { views: -1 });
    // Observed high point, at least two subsequent measured days below the
    // elevated threshold. No causal claim, significance test or invented end.
    if (peak.views >= Math.max(3 * article.baseline, 500) && peak.index <= 4
      && recent.slice(-2).every(point => point.views < threshold)) cooled.push({ ...article, kind: 'cooled', peakDate: peak.date, peakViews: peak.views, score });
  }
  const sort = list => list.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'he')).slice(0, limit);
  return { dataDate, startDate: shiftDate(dataDate, -6), comparedCount: articles.length,
    candidateCount: tracks?.items.filter(item => item.sampleDates.some(date => date <= dataDate)).length ?? 0,
    persistent: sort(persistent), cooled: sort(cooled) };
}
