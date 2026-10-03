import { fetchJson } from './live-state.js';
import { validateArchive } from './archive-state.js';
import { validateDescriptions } from './identification.js';
import { validateTracks } from './tracking-lib.js';

export async function loadReadingData({ baseUrl, previousArchive = null, previousDescriptions = null, previousTracks = null, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const [archive, descriptions, tracks] = await Promise.allSettled([
    fetchJson(new URL('data/archive.json', baseUrl), { fetchImpl, timeoutMs, optional: true }).then(value => value === null ? null : validateArchive(value)),
    fetchJson(new URL('data/descriptions.json', baseUrl), { fetchImpl, timeoutMs, optional: true }).then(value => value === null ? null : validateDescriptions(value)),
    // Revalidate ETag/Last-Modified: unchanged month-sized data need not be
    // downloaded again. The browser still checks with the server every refresh.
    fetchJson(new URL('data/tracks.json', baseUrl), { fetchImpl, timeoutMs, optional: true, cacheMode: 'no-cache' }).then(value => value === null ? null : validateTracks(value)),
  ]);
  return {
    archive: archive.status === 'fulfilled' ? archive.value ?? previousArchive : previousArchive,
    descriptions: descriptions.status === 'fulfilled' ? descriptions.value ?? previousDescriptions : previousDescriptions,
    archiveError: archive.status === 'rejected' ? archive.reason : null,
    descriptionError: descriptions.status === 'rejected' ? descriptions.reason : null,
    tracks: tracks.status === 'fulfilled' ? tracks.value ?? previousTracks : previousTracks,
    trackingError: tracks.status === 'rejected' ? tracks.reason : null,
  };
}
