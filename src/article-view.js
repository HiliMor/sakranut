import { chartMarkup, dateLabel, selectArticles } from './ui-lib.js';

// The overview depends only on the measurement snapshot, never on navigation.
export const leadingArticle = snapshot => selectArticles(snapshot.articles)[0];

export function detailChartMarkup(article) {
  // A missing history does not support a continuous comparison chart.
  if (article.reason === 'incomplete_history') return '';
  return `<section class="detail-chart" aria-labelledby="detail-chart-title"><div class="chart-heading"><h3 id="detail-chart-title">מסלול הקריאה</h3><span>14 ימים · צפיות ליום</span></div><div class="chart-legend"><span class="line-key">צפיות בפועל</span><span class="dash-key">רמת הבסיס</span></div>${chartMarkup(article, false, { inDetail: true })}<div class="chart-dates" dir="ltr"><span>${dateLabel(article.series.at(-14).date)}</span><span>${dateLabel(article.series.at(-1).date)}</span></div></section>`;
}
