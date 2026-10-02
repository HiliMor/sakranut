import './styles.css';
import { escapeHtml as e, number, ratioLabel, dateLabel, trendNames, chartMarkup } from './ui-lib.js';
import { POLL_INTERVAL_MS, contextFor, contextMarkup, deriveLiveState, loadLiveData, snapshotDisplayKey } from './live-state.js';
import { coverageSummary, partialCardsMarkup, partialResultMessage, selectUncomparedArticles } from './partial-history.js';
import { selectDiscoveryArticles, discoveryMetric } from './discovery-lib.js';
import { createRefreshController } from './refresh-controller.js';
import { leadingArticle, detailChartMarkup } from './article-view.js';

let snapshot, contexts, runtimeStatus, sort = 'surge', query = '', limit = 9;
let measurementKey = '', featuredContextKey = '', lastLoad = null, detailOpener = null;
const $ = selector => document.querySelector(selector);
const baseUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
const snapshotUrl = new URL('data/snapshot.json', baseUrl).href;
const timestampLabel = value => new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Jerusalem' }).format(new Date(value));
const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
const approvedContext = title => contextFor(contexts, title, snapshot.dataDate);
const articleTitle = article => article.title.replaceAll('_', ' ');
const articleUrl = article => `https://he.wikipedia.org/wiki/${encodeURIComponent(article.title)}`;
const findArticle = title => snapshot.articles.find(article => article.title === title) || snapshot.uncomparedArticles?.find(article => article.title === title);
const pageviewsUrl = article => `https://pageviews.wmcloud.org/?project=he.wikipedia.org&platform=all-access&agent=user&start=${snapshot.seriesStart}&end=${snapshot.dataDate}&pages=${encodeURIComponent(article.title)}`;
const explanations = {
  surge: 'מיון לפי היחס בין הצפיות ביום הנבחר לרמת הבסיס של אותו ערך. בסיס קטן מ־20 צפיות אינו מקבל יחס.',
  popular: 'מיון כל הערכים במדגם לפי הצפיות ביום הנבחר, גם כשאין היסטוריה מלאה. פופולריות אינה בהכרח עלייה בעניין.',
  lasting: 'לפחות שלושה ימים רצופים של עניין מוגבר, ללא ירידה חדה מהשיא. הרצף נבדק בתוך השבוע האחרון, עד לתאריך הנתונים.'
};

function renderFeature() {
  const a = leadingArticle(snapshot);
  const days = a.activeDays === null ? 'הבסיס נמוך מכדי לסווג את משך העניין באופן אמין' : a.activeDays >= 3 ? `${a.activeDays} ימים רצופים של עניין מוגבר בשבוע הנבדק` : a.activeDays > 0 ? `${a.activeDays === 1 ? 'יום אחד' : 'יומיים'} של עניין מוגבר — מוקדם לדעת אם יימשך` : 'אין כרגע רצף של עניין מוגבר לפי סף הניסוי';
  $('#feature').innerHTML = `<div class="feature-story"><p class="eyebrow"><span class="small-dot"></span>הקפיצה הבולטת במדגם</p><h2 id="feature-title">${e(articleTitle(a))}</h2><div class="feature-ratio"><strong class="feature-ratio-value">${e(ratioLabel(a.ratio))}</strong><span>${a.ratio == null ? 'לחישוב השוואה' : 'מרמת הקריאה הרגילה'}</span></div><p class="feature-sentence">${e(days)}.</p><button class="text-button detail-trigger" data-title="${e(a.title)}">לנתונים ולהסבר ←</button><p class="no-cause">מה גרם לשינוי? הנתונים האלה לבדם לא אומרים.</p></div><div class="feature-data"><div class="chart-heading"><h3>מסלול הקריאה</h3><span>14 ימים · צפיות ליום</span></div><div class="chart-legend"><span class="line-key">צפיות בפועל</span><span class="dash-key">רמת הבסיס</span></div>${chartMarkup(a)}<div class="chart-dates" dir="ltr"><span>${dateLabel(a.series.at(-14).date)}</span><span>${dateLabel(snapshot.dataDate)}</span></div><div class="feature-stats"><div><span>ביום הנבחר</span><strong>${number(a.views)}</strong><small>צפיות</small></div><div><span>רמת הבסיס</span><strong>${number(a.baseline)}</strong><small>חציון 28 יום</small></div><div><span>מצב העניין</span><strong class="trend-value">${trendNames[a.trend]}</strong><small>סיווג ניסיוני</small></div></div></div><div class="feature-context">${contextMarkup(approvedContext(a.title))}</div>`;
  featuredContextKey = JSON.stringify(approvedContext(a.title));
}

function renderGrid() {
  const all = selectDiscoveryArticles(snapshot, sort, query);
  $('#sort-explanation').textContent = query.trim() ? sort === 'lasting'
    ? 'תוצאות מכל הערכים במדגם, לא רק בעלי עניין מתמשך. מיון לפי אורך הרצף; ערכים בלי השוואת מגמה מוצגים אחריהם.'
    : `תוצאות מכל הערכים במדגם. ${explanations[sort]}` : explanations[sort];
  $('#article-grid').innerHTML = all.slice(0, limit).map((a, i) => {
    const metric = discoveryMetric(a, sort);
    return `<article class="article-card"><div class="card-top"><span class="card-rank">${String(i+1).padStart(2,'0')}</span><span class="trend-tag ${a.comparisonAvailable ? a.trend : 'uncompared'}">${a.comparisonAvailable ? trendNames[a.trend] : 'ללא השוואת מגמה'}</span></div><h3><button class="select-article detail-trigger" data-title="${e(a.title)}" aria-label="פירוט הנתונים: ${e(articleTitle(a))}">${e(articleTitle(a))}</button></h3><div class="card-metrics"><strong>${e(metric.value)}</strong><span>${e(metric.label)}</span><small>${e(metric.secondary)}</small></div>${a.comparisonAvailable ? chartMarkup(a,true) : `<p class="no-comparison">${a.views === null ? 'אין נתון צפיות ליום המדידה.' : 'אין היסטוריה מלאה להשוואת מגמה.'}</p>`}<div class="card-foot"><span>${a.comparisonAvailable ? 'לחיצה על השם פותחת גרף ופירוט ←' : 'לחיצה על השם פותחת פירוט ←'}</span></div></article>`;
  }).join('');
  $('#result-status').textContent = all.length ? `מוצגים ${Math.min(limit, all.length)} מתוך ${all.length} ערכים${query.trim() ? ' שמתאימים לחיפוש' : ' במיון הזה'}.` : 'לא נמצאו ערכים מתאימים במדגם הזה. אפשר לשנות חיפוש או מיון.';
  $('#show-more').hidden = all.length <= limit;
}

function renderUncompared() {
  const available = snapshot.uncomparedArticles || [];
  const filtered = selectUncomparedArticles(available, query);
  $('#uncompared').hidden = !available.length || sort === 'popular' || Boolean(query.trim());
  $('#uncompared-grid').innerHTML = partialCardsMarkup(filtered);
  const resultMessage = partialResultMessage({ count: filtered.length, query });
  $('#uncompared-status').hidden = !resultMessage;
  $('#uncompared-status').textContent = resultMessage;
}

function renderDetail(title) {
  const a = findArticle(title);
  if (!a) return;
  if (a.reason === 'incomplete_history') {
    $('#detail-content').innerHTML = `<p class="eyebrow">הנתונים הזמינים</p><h2 id="detail-title">${e(articleTitle(a))}</h2><p>${a.views === null ? 'אין נתון צפיות ליום המדידה.' : `<strong>${number(a.views)} צפיות</strong> ב־${dateLabel(snapshot.dataDate)}.`}</p><p>יש נתונים ל־${a.series.length} מתוך 35 ימי הבדיקה, ולכן לא מוצגים בסיס, מכפיל או סיווג מגמה. חוסר ברשומה אינו מוכיח אפס צפיות.</p><h3>הימים שיש להם נתונים</h3><table><caption class="sr-only">כל הצפיות היומיות הזמינות לערך</caption><thead><tr><th scope="col">תאריך</th><th scope="col">צפיות</th></tr></thead><tbody>${a.series.map(p => `<tr><th scope="row">${dateLabel(p.date, { year: 'numeric' })}</th><td>${number(p.views)}</td></tr>`).join('')}</tbody></table><details><summary>ימים ללא נתון (${a.missingDates.length})</summary><p>${a.missingDates.map(date => dateLabel(date, { year: 'numeric' })).join(' · ')}</p></details><div class="dialog-links"><a href="${articleUrl(a)}" target="_blank" rel="noopener">לערך בוויקיפדיה ↗</a><a href="${pageviewsUrl(a)}" target="_blank" rel="noopener">לבדיקה ב־Pageviews ↗</a></div>`;
    return;
  }
  const recent = a.series.slice(-14);
  $('#detail-content').innerHTML = `<p class="eyebrow">המספרים, בלי קיצורי דרך</p><h2 id="detail-title">${e(articleTitle(a))}</h2><p><strong>${number(a.views)} צפיות</strong> ב־${dateLabel(snapshot.dataDate)}. רמת הבסיס: <strong>${number(a.baseline)}</strong> צפיות ליום — חציון התקופה ${dateLabel(snapshot.baselineStart)} עד ${dateLabel(snapshot.baselineEnd)}.</p><div class="dialog-callout">${a.ratio == null ? 'רמת הבסיס קטנה מ־20, ולכן לא מציגים מכפיל שעלול להטעות.' : `${number(a.views)} ÷ ${number(a.baseline)} ≈ ${e(ratioLabel(a.ratio))} מהבסיס.`}</div><p>המספרים מודדים צפיות בעמוד, לא קוראים ייחודיים. הם אינם מוגבלים לגלישה מישראל ולא מוכיחים מה גרם לעלייה.</p>${detailChartMarkup(a)}<h3 id="detail-table-title">14 הימים שבגרף</h3><p>הטבלה מציגה את אותם ימים כמו הגרף. סיווג משך העניין נבדק בשבעת הימים האחרונים בלבד.</p><table><caption class="sr-only">צפיות יומיות ב־14 הימים שבגרף</caption><thead><tr><th scope="col">תאריך</th><th scope="col">צפיות</th><th scope="col">יחס לבסיס</th></tr></thead><tbody>${recent.map(p => `<tr><th scope="row">${dateLabel(p.date)}</th><td>${number(p.views)}</td><td>${e(ratioLabel(a.baseline >= 20 ? p.views / a.baseline : null))}</td></tr>`).join('')}</tbody></table><div class="dialog-links"><a href="${articleUrl(a)}" target="_blank" rel="noopener">לערך בוויקיפדיה ↗</a><a href="${pageviewsUrl(a)}" target="_blank" rel="noopener">לבדיקה ב־Pageviews ↗</a></div><details><summary>איך נקבע הסיווג?</summary><p>עניין מוגבר: פי שניים לפחות מהבסיס ולפחות 100 צפיות ביום. הרצף נספר עד היום הנבחר, בתוך שבעת הימים האחרונים בלבד. בבסיס קטן מ־20 אין סיווג של הרצף.</p><p>״ירידה מהשיא״: היום הנבחר נמוך ביותר מ־40% מהשיא בששת הימים שלפניו, והשיא עצמו עבר את סף העניין המוגבר. הסיווג הזה קודם לסיווגי הרצף — גם אם הצפיות עדיין גבוהות מהבסיס.</p><p>כשאין ירידה כזאת, רצף של שלושה ימים ומעלה מסומן ״עניין מתמשך״, ורצף של יום או יומיים מסומן ״זינוק חדש״. ״חדש״ מתייחס לרצף שמעל הסף, ולא מבטיח עלייה לעומת אתמול. ״ללא זינוק מזוהה״ אומר שכללי הניסוי לא זיהו אחד מהדפוסים האלה; זו אינה הוכחה ליציבות.</p><a href="/data/snapshot.json" target="_blank" rel="noopener">הנתונים וכללי הסיווג ↗</a></details>`;
  const contextSection = document.createElement('div');
  contextSection.className = 'detail-context';
  contextSection.innerHTML = contextMarkup(approvedContext(title));
  $('#detail-table-title').before(contextSection);
  $('#detail-content details a').href = snapshotUrl;
}

function showDetail(title, opener) {
  detailOpener = { element: opener, title, containerId: opener.closest('section')?.id, scrollX: window.scrollX, scrollY: window.scrollY };
  // Stop a pending smooth focus/anchor scroll before opening the modal.
  window.scrollTo({ left: detailOpener.scrollX, top: detailOpener.scrollY, behavior: 'instant' });
  renderDetail(title);
  $('.dialog-return').textContent = detailOpener.containerId === 'feature' ? 'חזרה לסקירה' : 'חזרה לרשימה';
  $('#detail').showModal();
  $('#detail').scrollTop = 0;
  $('#detail-title').tabIndex = -1;
  $('#detail-title').focus({ preventScroll: true });
}

$('#snapshot-link').href = snapshotUrl;

function renderRuntime() {
  if (!snapshot) return;
  const live = deriveLiveState(snapshot, runtimeStatus, Date.now(), Boolean(lastLoad?.statusError));
  const warnings = [...live.warnings];
  if (lastLoad?.snapshotError) warnings.push('לא הצלחנו לטעון עדכון תקין. הנתונים הקודמים נשמרו; ננסה שוב אוטומטית.');
  if (lastLoad?.statusError) warnings.push('לא הצלחנו לאמת את סטטוס האיסוף. אין בכך אישור לעדכון אוטומטי.');
  if (lastLoad?.contextError) warnings.push('לא הצלחנו לבדוק עדכונים להסברים. מוצגים רק הסברים שאושרו ונקלטו קודם, אם ישנם.');
  setText($('#edition-date'), `נתוני ${dateLabel(snapshot.dataDate, { year: 'numeric' })}`);
  setText($('#edition-status'), `${live.label}${refresh.paused ? ' · תצוגה מושהית' : ''}`);
  setText($('#snapshot-note'), `${timestampLabel(snapshot.generatedAt)} (שעון ישראל)`);
  setText($('#server-check-note'), live.checkedAt ? `${timestampLabel(live.checkedAt)} (שעון ישראל)` : 'לא זמין — אין אישור לתהליך מתוזמן');
  setText($('#runtime-note'), live.detail);
  const coverage = coverageSummary(snapshot);
  if (coverage.warning) warnings.push(coverage.warning);
  setText($('#sample-size'), coverage.sample);
  $('#coverage-note').hidden = !coverage.detail;
  setText($('#coverage-note'), coverage.detail);
  $('#update-warning').hidden = !warnings.length;
  setText($('#update-warning'), warnings.join(' '));
}

function preserveFocus(update) {
  const active = document.activeElement;
  const container = active?.closest('#feature, #article-grid, #uncompared-grid, #detail-content');
  const descriptor = container ? {
    containerId: container.id, id: active.id, title: active.dataset.title,
    tag: active.tagName, className: active.className, href: active.getAttribute('href'),
    openDetails: active.closest('details')?.open
  } : null;
  update();
  if (!descriptor || active.isConnected) return;
  const candidates = [...$(`#${descriptor.containerId}`).querySelectorAll('button, a, summary, [tabindex], h2')];
  const replacement = candidates.find(element => descriptor.id ? element.id === descriptor.id
    : descriptor.title ? element.dataset.title === descriptor.title && element.tagName === descriptor.tag && element.className === descriptor.className
    : descriptor.href ? element.getAttribute('href') === descriptor.href
    : element.tagName === descriptor.tag && element.className === descriptor.className);
  const target = replacement || $(`#${descriptor.containerId} h2`) || $('#discover-title');
  if (descriptor.openDetails && target.closest('details')) target.closest('details').open = true;
  if (!target.matches('button, a, summary, [tabindex]')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

async function load({ canApply }) {
  if (!snapshot) {
    $('#loading').hidden = false;
    $('#error').hidden = true;
    $('#content').hidden = true;
  }
  try {
    const result = await loadLiveData({ baseUrl, previousSnapshot: snapshot, previousContexts: contexts });
    // Keep both the open detail and its underlying list stable while reading.
    // A later scheduled check can apply updates after the dialog is closed.
    if (!canApply() || $('#detail').open) return;
    lastLoad = result;
    if (!lastLoad.snapshot) throw lastLoad.snapshotError || new Error('No valid snapshot');
    const nextKey = snapshotDisplayKey(lastLoad.snapshot);
    snapshot = lastLoad.snapshot;
    contexts = lastLoad.contexts;
    runtimeStatus = lastLoad.status;
    preserveFocus(() => {
      if (nextKey !== measurementKey) { renderFeature(); renderGrid(); renderUncompared(); }
      else if (featuredContextKey !== JSON.stringify(approvedContext(leadingArticle(snapshot).title))) renderFeature();
    });
    measurementKey = nextKey;
    renderRuntime();
    $('#content').hidden = false;
    $('#error').hidden = true;
  } catch (error) {
    if (!canApply() || $('#detail').open) return;
    if (!snapshot) {
      $('#error').hidden = false;
      setText($('#edition-date'), 'אין נתונים מאומתים');
    } else {
      $('#update-warning').hidden = false;
      setText($('#update-warning'), 'לא הצלחנו לרענן את התצוגה. הנתונים הקודמים נשמרו; ננסה שוב אוטומטית.');
    }
    console.error('Wikipedia snapshot unavailable:', error.message);
  } finally { $('#loading').hidden = true; }
}

function renderRefreshControls() {
  $('#pause-refresh').checked = refresh.paused;
  $('#refresh-now').setAttribute('aria-disabled', String(refresh.busy));
  setText($('#refresh-state'), refresh.busy ? 'בודקים אם פורסם עדכון…' : refresh.paused ? 'התצוגה מושהית; האיסוף בשרת ממשיך.' : '');
  if (snapshot) renderRuntime();
}
const refresh = createRefreshController({ load, intervalMs: POLL_INTERVAL_MS, isVisible: () => !document.hidden && !$('#detail').open, onChange: renderRefreshControls });
$('#pause-refresh').addEventListener('change', event => { refresh.setPaused(event.target.checked); });
$('#refresh-now').addEventListener('click', () => { if (!refresh.busy) refresh.request(); });

$('.tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-sort]'); if (!button) return;
  sort = button.dataset.sort; limit = 9;
  document.querySelectorAll('[data-sort]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  renderGrid(); renderUncompared();
});
$('#search').addEventListener('input', event => { query = event.target.value; limit = 9; renderGrid(); renderUncompared(); });
$('#show-more').addEventListener('click', () => {
  const firstNewIndex = $('#article-grid').children.length;
  limit += 9; renderGrid();
  $('#article-grid').children[firstNewIndex]?.querySelector('.detail-trigger')?.focus();
});
$('#content').addEventListener('click', event => {
  const detail = event.target.closest('.detail-trigger');
  if (detail) return showDetail(detail.dataset.title, detail);
});
$('.dialog-close').addEventListener('click', () => $('#detail').close());
$('.dialog-return').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('close', () => {
  if (!detailOpener) return;
  const sameSection = document.getElementById(detailOpener.containerId);
  const replacement = [...(sameSection?.querySelectorAll('.detail-trigger') || [])].find(button => button.dataset.title === detailOpener.title);
  const target = detailOpener.element.isConnected ? detailOpener.element : replacement || $('#discover-title');
  if (!target.matches('button, a, [tabindex]')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  window.scrollTo({ left: detailOpener.scrollX, top: detailOpener.scrollY, behavior: 'instant' });
  detailOpener = null;
});
$('#detail').addEventListener('click', event => { if (event.target === $('#detail')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
$('#retry').addEventListener('click', () => refresh.request());
document.addEventListener('visibilitychange', () => refresh.request('automatic'));
refresh.request('initial');
