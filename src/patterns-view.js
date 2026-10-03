import { chartMarkup, dateLabel, escapeHtml as e, number } from './ui-lib.js';
import { weeklyPatterns } from './tracking-lib.js';

export function patternsMarkup(tracks, dataDate, identify = () => '') {
  const patterns = weeklyPatterns(tracks, dataDate, { limit: 2 });
  if (!patterns.candidateCount) return '';
  const group = (kind, title, explanation) => {
    const cards = patterns[kind];
    return `<div class="pattern-group"><h3>${e(title)}</h3><p class="pattern-explanation">${e(explanation)}</p>${cards.length ? `<ul role="list">${cards.map(article => `<li class="pattern-item">
      <div><h4><button class="select-article detail-trigger" data-title="${e(article.title)}" aria-label="מעקב שבועי: ${e(article.title)}">${e(article.title)}<span aria-hidden="true"> ←</span></button></h4>${identify(article.title)}
      <p class="pattern-observation">${kind === 'persistent' ? `<strong>${number(article.activeDays)} ימים ברצף</strong> מעל סף העניין המוגבר · ${number(article.views)} צפיות ביום הנבחר`
        : `שיא של <strong>${number(article.peakViews)}</strong> ב־${e(dateLabel(article.peakDate))} · ${number(article.views)} צפיות ביום הנבחר`}</p></div>
      <div class="pattern-chart">${chartMarkup(article, true)}</div>
      </li>`).join('')}</ul>` : '<p class="pattern-empty">לא זוהה דפוס כזה בנתונים המלאים של השבוע.</p>'}</div>`;
  };
  return `<div class="patterns-heading"><div><p class="eyebrow">מבט שבועי</p><h2 id="patterns-title">מה נשאר, ומה נרגע?</h2></div><p>${e(dateLabel(patterns.startDate))}–${e(dateLabel(dataDate, { year: 'numeric' }))}</p></div>
    <div class="patterns-groups">${group('persistent', 'ממשיך לבלוט', 'לפחות שלושה ימים רצופים מעל הרמה הרגילה.')}${group('cooled', 'עלה ואז נרגע', 'שיא בולט, ואחריו לפחות יומיים מתחת לסף העניין המוגבר.')}</div>
    <details class="patterns-method"><summary>איך נבחרו הדפוסים?</summary>
      <p>נבדקו ${number(patterns.comparedCount)} מתוך ${number(patterns.candidateCount)} ערכים שנדגמו עד היום הנבחר. נדרש חלון מלא של 35 ימים ובסיס של לפחות 20 צפיות; חוסר בנתון אינו אפס. אלה דפוסי צפייה במדגם, לא הסברים לסיבה.</p>
      <p>עניין מוגבר הוא לפחות פי שניים מחציון 28 הימים שלפני השבוע ולפחות 100 צפיות ליום. ״עלה ואז נרגע״ דורש שיא שבועי של לפחות פי שלושה מהבסיס ו־500 צפיות, ואחריו שני ימים אחרונים מתחת לסף. בכל קבוצה מוצגים עד שני ערכים, לפי סך הצפיות שמעל הבסיס בשבוע.</p>
      <p>ערך נשאר במעקב עד 30 יום מהופעתו האחרונה במדגם, גם כשאינו במובילי היום. הגרפים הקטנים מציגים 14 ימים ובקני מידה נפרדים; לחיצה פותחת את המספרים ואת הטבלה.</p>
      <a href="./data/tracks.json" target="_blank" rel="noopener noreferrer">נתוני המעקב (JSON) ↗</a>
    </details>`;
}
