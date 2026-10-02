import { BASELINE_DAYS, DISPLAY_DAYS } from '../data-lib.mjs';
import { dateLabel, escapeHtml as e, number } from './ui-lib.js';

const REQUIRED_DAYS = BASELINE_DAYS + DISPLAY_DAYS;

export function selectUncomparedArticles(articles = [], query = '') {
  const term = query.trim().toLocaleLowerCase('he');
  return articles.filter(article => article.title.replaceAll('_', ' ').toLocaleLowerCase('he').includes(term))
    .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title, 'he'));
}

export function coverageSummary(snapshot) {
  const compared = snapshot.articles.length;
  const partial = snapshot.uncomparedArticles?.length ?? 0;
  const candidates = snapshot.coverage.candidateCount;
  const unavailable = candidates - compared - partial;
  const sample = `${compared} ערכים להשוואה${partial ? ` · ${partial} ללא היסטוריה מלאה` : ''} · מתוך ${candidates} שנבחרו`;
  const notices = [];
  if (partial) notices.push(`${partial} ערכים ללא היסטוריה מלאה מוצגים בלי השוואת מגמה, ונכללים בדירוג הצפיות ובחיפוש.`);
  if (unavailable) notices.push(`${unavailable} ערכים נוספים לא מוצגים בגלל נתונים חסרים או שגיאת איסוף. פירוט בקובץ הנתונים.`);
  return {
    compared, partial, candidates, unavailable, sample,
    detail: notices.join(' '),
    warning: unavailable ? `לא ניתן להציג ${unavailable === 1 ? 'ערך אחד' : `${unavailable} ערכים`} בגלל נתונים לא זמינים. פירוט בפרטי הנתונים.` : ''
  };
}

export function comparisonResultMessage({ count, shown, partialCount, query = '' }) {
  if (count) return `מוצגים ${shown} מתוך ${count} ערכים להשוואה${query ? ' שמתאימים לחיפוש' : ''}. לחיצה על שם ערך מעדכנת את הגרף הראשי.`;
  if (partialCount) return `לא נמצאו ערכים להשוואת מגמות במיון ובחיפוש האלה. ${partialCount === 1 ? 'ערך אחד ללא היסטוריה מלאה מופיע' : `${partialCount} ערכים ללא היסטוריה מלאה מופיעים`} בסעיף הבא.`;
  return 'לא נמצאו ערכים מתאימים במדגם הזה. אפשר לשנות חיפוש או מיון.';
}

export function partialResultMessage({ count, query = '' }) {
  if (!query.trim()) return '';
  return count ? `${count === 1 ? 'נמצא ערך נוסף אחד' : `נמצאו ${count} ערכים נוספים`} בהתאם לחיפוש.` : 'לא נמצאו כאן ערכים שמתאימים לחיפוש.';
}

export function partialCardsMarkup(articles) {
  return articles.map(article => {
    const title = article.title.replaceAll('_', ' ');
    // Construct the only navigable URL here; data links cannot redirect off Wikipedia.
    const url = `https://he.wikipedia.org/wiki/${encodeURIComponent(article.title)}`;
    const countLabel = article.views === null
      ? '<span class="partial-no-count">אין נתון ליום המדידה</span>'
      : `<strong>${number(article.views)}</strong><span>צפיות ביום המדידה</span>`;
    return `<article class="partial-card"><h3><button class="select-article detail-trigger" data-title="${e(article.title)}" aria-label="פירוט הנתונים: ${e(title)}">${e(title)}</button></h3><p class="partial-views">${countLabel}</p><details class="partial-availability"><summary data-title="${e(article.title)}">פירוט הנתונים<span class="sr-only">: ${e(title)}</span></summary><p>נתונים זמינים ל־${article.series.length} מתוך ${REQUIRED_DAYS} ימים. חוסר ברשומה אינו מוכיח אפס צפיות.</p><p>ימים חסרים (${article.missingDates.length}): ${article.missingDates.map(date => dateLabel(date, { year: 'numeric' })).join(' · ')}</p></details><a class="partial-source" href="${e(url)}" target="_blank" rel="noopener noreferrer">לערך בוויקיפדיה ↗<span class="sr-only"> — נפתח בחלון חדש</span></a></article>`;
  }).join('');
}
