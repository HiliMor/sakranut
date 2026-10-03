import { parseDate } from '../data-lib.mjs';
import { validateSnapshot } from './ui-lib.js';

export function validArchiveDate(value) {
  try { parseDate(value); return true; } catch { return false; }
}

export function validateArchive(value) {
  const timestamp = item => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(item) && Number.isFinite(Date.parse(item));
  if (value?.schemaVersion !== 1 || !validArchiveDate(value.latestDate)
    || !timestamp(value.generatedAt) || !timestamp(value.latestGeneratedAt)
    || !Array.isArray(value.availableDates) || !value.availableDates.length
    || value.availableDates.some((date, i) => !validArchiveDate(date)
      || date > value.latestDate || (i > 0 && date <= value.availableDates[i - 1]))
    || value.availableDates.at(-1) !== value.latestDate) throw new Error('Invalid archive index');
  return value;
}

export function archiveSnapshotUrl(baseUrl, date) {
  if (!validArchiveDate(date)) throw new Error('Invalid archive date');
  return new URL(`data/archive/${date}.json`, baseUrl).href;
}

// Latest collection and the user's selected edition are deliberately separate.
// A refresh cannot replace a historical edition; only returning to latest can.
export function createEditionController({ loadSnapshot, onChange = () => {} }) {
  let latest = null, displayed = null, index = null, historical = false;
  let busy = false, error = '', requestedDate = null, generation = 0;
  const changed = reason => onChange(reason);
  const dates = () => [...new Set([
    ...(index?.availableDates.filter(date => latest && date <= latest.dataDate) ?? []),
    ...(latest ? [latest.dataDate] : []), ...(displayed ? [displayed.dataDate] : []),
  ])].sort();
  const controller = {
    get latest() { return latest; }, get displayed() { return displayed; },
    get historical() { return historical; }, get busy() { return busy; },
    get error() { return error; }, get requestedDate() { return requestedDate; },
    get dates() { return dates(); },
    setLatest(snapshot) {
      latest = snapshot;
      if (!historical) displayed = snapshot;
      changed('latest');
    },
    setArchive(value) { index = value === null ? null : validateArchive(value); changed('availability'); },
    showLatest() {
      generation++;
      historical = false; busy = false; error = ''; requestedDate = null;
      displayed = latest;
      changed('selection');
    },
    async select(date) {
      if (!validArchiveDate(date) || !dates().includes(date)) throw new Error('Unavailable archive day');
      if (date === latest?.dataDate) { controller.showLatest(); return; }
      const started = ++generation;
      busy = true; requestedDate = date; error = '';
      changed('loading');
      try {
        const snapshot = validateSnapshot(await loadSnapshot(date));
        if (snapshot.dataDate !== date) throw new Error('Archive date mismatch');
        if (started !== generation) return;
        displayed = snapshot; historical = true;
      } catch {
        if (started !== generation) return;
        error = 'לא הצלחנו לטעון את היום שבחרת. הנתונים המוצגים לא השתנו; אפשר לנסות שוב.';
      } finally {
        if (started === generation) {
          busy = false; requestedDate = null;
          changed('selection');
        }
      }
    },
  };
  return controller;
}
