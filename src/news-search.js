import { shiftDate } from '../data-lib.mjs';

const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/**
 * Build an external, user-initiated web search around the measurement day.
 * Google's documented date operators concern a document's last update, not
 * a verified publication/event date or evidence of a spike's cause.
 * https://support.google.com/websearch/answer/2466433?hl=en
 * This helper does not fetch, prefetch, or inspect any search results.
 */
export function newsSearchUrl(title, dataDate) {
  if (typeof title !== 'string' || !validDate(dataDate)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(title)) return null;

  // Preserve acronym punctuation without allowing quotes in a title to end
  // the surrounding search phrase. URLSearchParams keeps URL syntax literal.
  const normalizedTitle = title.normalize('NFC').replaceAll('_', ' ')
    .replace(/["“”„]/gu, '״').replace(/\s+/gu, ' ').trim();
  if (!normalizedTitle || normalizedTitle.length > 512) return null;

  const after = shiftDate(dataDate, -1);
  const before = shiftDate(dataDate, 2);
  if (!validDate(after) || !validDate(before)) return null;

  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', `"${normalizedTitle}" after:${after} before:${before}`);
  url.searchParams.set('hl', 'he');
  url.searchParams.set('gl', 'IL');
  return url.href;
}
