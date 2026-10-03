const dayMilliseconds = 24 * 60 * 60 * 1000;
const measuredViews = value => Number.isSafeInteger(value) && value >= 0;
const titleKey = title => typeof title === 'string'
  ? title.normalize('NFC').replaceAll('_', ' ').replace(/\s+/gu, ' ').trim()
  : '';
const lexicalOrder = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function dateTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp : null;
}

function observations(article, dataDate, previousDate) {
  if (!Array.isArray(article?.series) || !measuredViews(article.views)) return null;
  const counts = new Map();
  for (const point of article.series) {
    if (dateTimestamp(point?.date) === null || !measuredViews(point?.views)) return null;
    if (counts.has(point.date) && counts.get(point.date) !== point.views) return null;
    counts.set(point.date, point.views);
  }
  if (!counts.has(previousDate) || !counts.has(dataDate) || counts.get(dataDate) !== article.views) return null;
  return counts;
}

/**
 * The largest observed daily changes within this snapshot's sample, not the
 * whole of Wikipedia or a change in rank. Calendar days come from dataDate,
 * never the computer clock. Partial baseline histories may still have a valid
 * daily pair; missing observations are never converted to zero.
 *
 * Invalid articles are excluded. Duplicate titles count once, but disagreement
 * in any shared observation (or an invalid duplicate) excludes the whole title.
 * Returned titles are plain text; HTML callers must escape them.
 */
export function dailyBriefing(snapshot, { limit = 3 } = {}) {
  const timestamp = dateTimestamp(snapshot?.dataDate);
  const previousDate = timestamp === null ? null : new Date(timestamp - dayMilliseconds).toISOString().slice(0, 10);
  if (timestamp === null || dateTimestamp(previousDate) === null) {
    return { dataDate: null, previousDate: null, comparedCount: 0, insights: [] };
  }
  const dataDate = snapshot.dataDate;
  const maximum = Number.isSafeInteger(limit) && limit >= 0 ? Math.min(limit, 3) : 3;
  const articles = [
    ...(Array.isArray(snapshot.articles) ? snapshot.articles : []),
    ...(Array.isArray(snapshot.uncomparedArticles) ? snapshot.uncomparedArticles : []),
  ];
  const groups = new Map();
  for (const article of articles) {
    const key = titleKey(article?.title);
    if (!key) continue;
    const counts = observations(article, dataDate, previousDate);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { title: article.title, counts });
      continue;
    }
    // Canonical choice is stable even when the source arrays are reordered.
    if (lexicalOrder(article.title, existing.title) < 0) existing.title = article.title;
    if (!existing.counts || !counts) {
      existing.counts = null;
      continue;
    }
    for (const [date, views] of counts) {
      if (existing.counts.has(date) && existing.counts.get(date) !== views) {
        existing.counts = null;
        break;
      }
      existing.counts.set(date, views);
    }
  }
  const compared = [...groups.values()].filter(article => article.counts);
  const insights = compared.map(({ title, counts }) => {
    const views = counts.get(dataDate);
    const previousViews = counts.get(previousDate);
    const delta = views - previousViews;
    return {
      kind: delta > 0 ? 'increase' : 'decrease',
      title,
      previousViews,
      views,
      delta,
      percentChange: previousViews === 0 ? null : delta / previousViews * 100,
    };
  }).filter(article => article.delta !== 0).sort((left, right) =>
    Math.abs(right.delta) - Math.abs(left.delta) || lexicalOrder(titleKey(left.title), titleKey(right.title))
  ).slice(0, maximum);
  return { dataDate, previousDate, comparedCount: compared.length, insights };
}
