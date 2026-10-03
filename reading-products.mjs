import { publishArchive } from './archive-products.mjs';
import { publishDescriptions } from './description-products.mjs';
import { publishTracks } from './tracking-products.mjs';

// Optional reading aids run under the collector's existing lock and schedule.
// They cannot alter measurements, runner health, reviewed context or lastSuccessAt.
export async function updateReadingProducts({ runtimeDir, snapshot, now = new Date(), logger = console, fetchImpl, waitImpl }) {
  if (!snapshot) return;
  let titles = [], priorityTitles = [];
  try {
    const archive = await publishArchive({ runtimeDir, snapshot, now, logger });
    titles = archive.titles;
  } catch { logger.warn('Archive: optional publication failed; retained existing archive, measurements unaffected.'); }
  try {
    const tracking = await publishTracks({ runtimeDir, snapshot, now, logger, fetchImpl, waitImpl });
    titles = [...new Set([...titles, ...tracking.titles])];
    priorityTitles = tracking.priorityTitles;
    logger.log(`Tracking: ${tracking.tracked} titles; ${tracking.requests} requests; ${tracking.pending} pending.`);
  } catch { logger.warn('Tracking: optional publication failed; retained existing product, measurements unaffected.'); }
  try {
    const currentTitles = [...new Set([...snapshot.articles, ...(snapshot.uncomparedArticles ?? [])].map(article => article.title).concat(priorityTitles))];
    const result = await publishDescriptions({ runtimeDir, titles, currentTitles, now, logger, fetchImpl, waitImpl });
    logger.log(`Reading aids: ${result.described} descriptions; ${result.requests} requests; ${result.pending} pending.`);
  } catch { logger.warn('Descriptions: optional publication failed; retained existing file, measurements unaffected.'); }
}
