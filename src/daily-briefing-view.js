import { dailyBriefing } from './daily-briefing.js';
import { escapeHtml as e, number, dateLabel } from './ui-lib.js';

export function dailyBriefingMarkup(snapshot) {
  const briefing = dailyBriefing(snapshot);
  if (!briefing.dataDate) return '';
  const period = `${dateLabel(briefing.dataDate, { year: 'numeric' })} לעומת ${dateLabel(briefing.previousDate, { year: 'numeric' })}`;
  const cards = briefing.insights.map(insight => {
    const title = insight.title.replaceAll('_', ' ');
    const direction = insight.kind === 'increase' ? 'עלייה' : 'ירידה';
    return `<li class="briefing-item ${insight.kind}">
      <p class="briefing-direction"><span aria-hidden="true">${insight.kind === 'increase' ? '↗' : '↘'}</span> ${direction} ביום אחד</p>
      <h3><button class="select-article detail-trigger" data-title="${e(insight.title)}" aria-label="פירוט השינוי היומי: ${e(title)}">${e(title)}</button></h3>
      <p class="briefing-delta"><strong><bdi>${number(Math.abs(insight.delta))}</bdi></strong> צפיות ${insight.kind === 'increase' ? 'יותר' : 'פחות'}</p>
      <p class="briefing-counts">מ־<bdi>${number(insight.previousViews)}</bdi> ל־<bdi>${number(insight.views)}</bdi> צפיות</p>
      <p class="briefing-hint">לחיצה על השם פותחת פירוט ←</p>
    </li>`;
  }).join('');
  const note = briefing.insights.length
    ? `עד שלושה מהשינויים הגדולים במספר הצפיות, מתוך ${briefing.comparedCount} ערכים עם נתונים לשני הימים. זו השוואה ליום הקודם, לא לבסיס החודשי.`
    : briefing.comparedCount
      ? `ב־${briefing.comparedCount} הערכים שיש להם נתונים לשני הימים, מספר הצפיות לא השתנה.`
      : 'אין כרגע מספיק נתונים להשוואה בין שני הימים.';
  return `<div class="briefing-heading"><h2 id="daily-briefing-title">מה השתנה ביום אחד?</h2><p>${e(period)} · UTC</p></div>
    ${cards ? `<ul class="briefing-list" role="list">${cards}</ul>` : ''}
    <p class="briefing-note">${e(note)}</p>`;
}

export function dailyChangeMarkup(article, dataDate) {
  const { previousDate, insights } = dailyBriefing({ dataDate, articles: [article] });
  const change = insights[0];
  if (!change) return '';
  return `<p class="detail-daily-change">לעומת ${e(dateLabel(previousDate))}: <strong>${number(Math.abs(change.delta))} צפיות ${change.kind === 'increase' ? 'יותר' : 'פחות'}</strong> — מ־<bdi>${number(change.previousViews)}</bdi> ל־<bdi>${number(change.views)}</bdi>.</p>`;
}
