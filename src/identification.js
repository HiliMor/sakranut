import { escapeHtml as e } from './ui-lib.js';

export const DESCRIPTION_SOURCE = Object.freeze({
  name: 'Wikidata', license: 'CC0 1.0',
  url: 'https://www.wikidata.org/wiki/Wikidata:Licensing',
});
export const normalizeTitle = title => title.replaceAll('_', ' ');
export const validTitle = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 300 && !/[|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value);
export const validDescription = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 300 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value);
export const validEntityId = value => typeof value === 'string' && /^Q[1-9]\d*$/.test(value);
export const validRetrievedAt = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

export function validateDescriptions(value) {
  if (value?.schemaVersion !== 1 || !validRetrievedAt(value.generatedAt)
    || Object.keys(DESCRIPTION_SOURCE).some(key => value.source?.[key] !== DESCRIPTION_SOURCE[key])
    || !Array.isArray(value.items)) throw new Error('Invalid description file');
  const seen = new Set();
  const items = value.items.map(item => {
    if (!validTitle(item?.title) || !validEntityId(item.entityId) || !validDescription(item.description)
      || !validRetrievedAt(item.fetchedAt) || Date.parse(item.fetchedAt) > Date.parse(value.generatedAt)
      || seen.has(normalizeTitle(item.title))) throw new Error('Invalid description record');
    seen.add(normalizeTitle(item.title));
    return { title: item.title, entityId: item.entityId, description: item.description, fetchedAt: item.fetchedAt };
  });
  return { schemaVersion: 1, generatedAt: value.generatedAt, source: { ...DESCRIPTION_SOURCE }, items };
}

export function descriptionFor(descriptions, title) {
  return descriptions?.items.find(item => normalizeTitle(item.title) === normalizeTitle(title)) ?? null;
}

export function identificationMarkup(descriptions, title, { detail = false } = {}) {
  const item = descriptionFor(descriptions, title);
  if (!item) return '';
  const source = detail ? `<span class="identification-source"><a href="https://www.wikidata.org/wiki/${item.entityId}" target="_blank" rel="noopener noreferrer">זיהוי קצר · ויקינתונים ↗<span class="sr-only"> — נפתח בחלון חדש</span></a><span>נשלף ${new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' }).format(new Date(item.fetchedAt))}; אינו הסבר לזינוק או תיאור היסטורי של היום הנבחר.</span></span>` : '';
  return `<p class="article-identification${detail ? ' detail-identification' : ''}">${e(item.description)}${source}</p>`;
}
