import { fetchJson } from './live-state.js';
import { validateArchive } from './archive-state.js';
import { validateDescriptions } from './identification.js';

export async function loadReadingData({ baseUrl, previousArchive = null, previousDescriptions = null, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const [archive, descriptions] = await Promise.allSettled([
    fetchJson(new URL('data/archive.json', baseUrl), { fetchImpl, timeoutMs, optional: true }).then(value => value === null ? null : validateArchive(value)),
    fetchJson(new URL('data/descriptions.json', baseUrl), { fetchImpl, timeoutMs, optional: true }).then(value => value === null ? null : validateDescriptions(value)),
  ]);
  return {
    archive: archive.status === 'fulfilled' ? archive.value ?? previousArchive : previousArchive,
    descriptions: descriptions.status === 'fulfilled' ? descriptions.value ?? previousDescriptions : previousDescriptions,
    archiveError: archive.status === 'rejected' ? archive.reason : null,
    descriptionError: descriptions.status === 'rejected' ? descriptions.reason : null,
  };
}
