import { number, ratioLabel } from './ui-lib.js';

const normalized = value => typeof value === 'string'
  ? value.normalize('NFC').replaceAll('_', ' ').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('he')
  : '';
const modeFor = sort => ['surge', 'popular', 'lasting'].includes(sort) ? sort : 'surge';
const knownViews = value => Number.isSafeInteger(value) && value >= 0;
const knownMetric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Missing observations sort after every measured value, including observed zero.
function descendingKnown(a, b, predicate = knownMetric) {
  const hasA = predicate(a), hasB = predicate(b);
  if (hasA !== hasB) return hasA ? -1 : 1;
  return hasA ? b - a : 0;
}

function sourceTie(a, b) {
  const rankA = Number.isSafeInteger(a.rank) && a.rank > 0 ? a.rank : Infinity;
  const rankB = Number.isSafeInteger(b.rank) && b.rank > 0 ? b.rank : Infinity;
  return rankA - rankB || normalized(a.title).localeCompare(normalized(b.title), 'he');
}

/**
 * Pure presentation selection for an already validated snapshot. The returned
 * records are shallow copies: comparisonAvailable is UI metadata, not a new
 * measurement or a change to the stored snapshot schema.
 *
 * Popular includes both histories because their observed daily counts compare
 * directly. Search spans both groups regardless of the active tab; without a
 * query, sustained interest retains its existing sustained-only filter.
 */
export function selectDiscoveryArticles(snapshot, sort = 'surge', query = '') {
  const mode = modeFor(sort), term = normalized(query);
  const comparable = (snapshot?.articles ?? []).map(article => ({ ...article, comparisonAvailable: true }));
  const partial = (snapshot?.uncomparedArticles ?? []).map(article => ({ ...article, comparisonAvailable: false }));
  const eligible = mode === 'popular' || term ? [...comparable, ...partial]
    : mode === 'lasting' ? comparable.filter(article => article.trend === 'sustained') : comparable;
  return eligible.filter(article => !term || normalized(article.title).includes(term)).sort((a, b) => {
    if (mode !== 'popular' && a.comparisonAvailable !== b.comparisonAvailable) return a.comparisonAvailable ? -1 : 1;
    if (mode === 'surge' && a.comparisonAvailable && b.comparisonAvailable) {
      const difference = descendingKnown(a.ratio, b.ratio);
      if (difference) return difference;
    }
    if (mode === 'lasting' && a.comparisonAvailable && b.comparisonAvailable) {
      const difference = descendingKnown(a.activeDays, b.activeDays);
      if (difference) return difference;
    }
    return descendingKnown(a.views, b.views, knownViews) || sourceTie(a, b);
  });
}

/** Plain display strings: callers must escape them when inserting HTML. */
export function discoveryMetric(article, sort = 'surge') {
  const mode = modeFor(sort);
  const partial = article.comparisonAvailable === false || article.reason === 'incomplete_history';
  const views = knownViews(article.views)
    ? { value: number(article.views), label: 'צפיות ביום המדידה' }
    : { value: '—', label: 'אין נתון ליום המדידה' };
  if (partial) return { ...views, secondary: 'בלי השוואת מגמה' };
  const viewSummary = knownViews(article.views) ? `${number(article.views)} צפיות ביום המדידה` : 'אין נתון ליום המדידה';
  if (mode === 'popular') return {
    ...views,
    secondary: knownMetric(article.ratio) ? `${ratioLabel(article.ratio)} מרמת הבסיס` : 'אין בסיס מספיק להשוואה',
  };
  if (mode === 'lasting') return {
    value: knownMetric(article.activeDays) ? number(article.activeDays) : '—',
    label: knownMetric(article.activeDays)
      ? article.activeDays === 1 ? 'יום רצוף של עניין מוגבר' : 'ימים רצופים של עניין מוגבר'
      : 'אין בסיס לחישוב רצף',
    secondary: viewSummary,
  };
  return {
    value: knownMetric(article.ratio) ? ratioLabel(article.ratio) : 'ללא בסיס מספיק',
    label: knownMetric(article.ratio) ? 'מרמת הבסיס של הערך' : 'להשוואת מגמה',
    secondary: viewSummary,
  };
}
