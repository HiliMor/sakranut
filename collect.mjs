import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { articleSeriesUrl, buildArticle, buildUncomparedArticle, METHOD, parseDate, retryDelayMs, selectCandidates, shiftDate, topUrl, windowFor } from './data-lib.mjs';
import { validateSnapshot } from './src/ui-lib.js';
import { atomicJson } from './runtime-lib.mjs';

const userAgent = 'Sakranut/0.2 (https://github.com/HiliMor/sakranut) Node.js';

export async function fetchJson(url, { fetchImpl = fetch, waitImpl = wait } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Sequential, spaced requests only. Never shorten publisher Retry-After.
    await waitImpl(200);
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(25_000),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const retryAfter = response.headers.get('retry-after');
      await response.body?.cancel();
      await waitImpl(retryDelayMs(retryAfter, { attempt }));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      if (response.status === 429 || response.headers.has('retry-after')) error.code = 'STOP_COLLECTION';
      throw error;
    }
    return response.json();
  }
}

// Fetch and validate in memory. Publishing is deliberately a separate operation.
// Scheduled runs pass maxFallbackDays: 0; the manual prototype retains fallback.
export async function collectSnapshot({ requestedDate, maxFallbackDays = 3, fetchImpl = fetch, waitImpl = wait, now = () => new Date(), logger = console } = {}) {
  const today = now().toISOString().slice(0, 10);
  requestedDate ??= shiftDate(today, -1);
  parseDate(requestedDate);
  if (requestedDate >= today) throw new Error('Choose a completed UTC day, before today');
  if (!Number.isInteger(maxFallbackDays) || maxFallbackDays < 0 || maxFallbackDays > 3) throw new Error('Invalid fallback window');
  let dataDate, topArticles, fallbackDays;
  for (let offset = 0; offset <= maxFallbackDays; offset += 1) {
    const candidateDate = shiftDate(requestedDate, -offset);
    try {
      const response = await fetchJson(topUrl(candidateDate), { fetchImpl, waitImpl });
      const day = response.items?.[0];
      if (!Array.isArray(day?.articles) || !day.articles.length) throw new Error('Top list missing or empty');
      if (`${day.year}-${day.month}-${day.day}` !== candidateDate) throw new Error('Top-list date differs from requested date');
      dataDate = candidateDate;
      fallbackDays = offset;
      topArticles = day.articles;
      break;
    } catch (error) {
      if (error.status !== 404 || offset === maxFallbackDays) throw error;
      logger.warn(`Top list unavailable for ${candidateDate}; checking previous day.`);
    }
  }

  const candidates = selectCandidates(topArticles);
  const articles = [], uncomparedArticles = [], failures = [];
  for (const candidate of candidates) {
    let responseItems;
    try {
      const response = await fetchJson(articleSeriesUrl(candidate.article, dataDate), { fetchImpl, waitImpl });
      if (!Array.isArray(response.items)) throw new Error('Missing per-article daily series');
      responseItems = response.items;
      articles.push(buildArticle(candidate, responseItems, dataDate));
      logger.log(`Collected ${articles.length}/${candidates.length}: ${candidate.article}`);
    } catch (error) {
      if (error.code === 'STOP_COLLECTION') throw error;
      // Only a successfully parsed, demonstrably incomplete response can appear
      // without comparison metrics. Network/malformed failures get no card.
      if (error.code === 'INCOMPLETE_HISTORY') uncomparedArticles.push(buildUncomparedArticle(candidate, responseItems, dataDate));
      // Publish bounded diagnoses, not arbitrary network errors or request URLs.
      const reason = error.status ? `HTTP ${error.status}` : error.code === 'INCOMPLETE_HISTORY' ? 'Incomplete 35-day series' : 'Invalid or unavailable daily series';
      failures.push({ title: candidate.article.replaceAll('_', ' '), error: reason });
      logger.warn(`Excluded from comparison: ${reason}`);
    }
  }
  if (!articles.length || articles.length < Math.ceil(candidates.length * 0.75)) {
    const error = new Error('Fewer than 75% of candidates have complete 35-day series; keeping existing snapshot.');
    error.code = 'PARTIAL_DATA';
    throw error;
  }
  const { seriesStart, baselineStart, baselineEnd } = windowFor(dataDate);
  return validateSnapshot({
    schemaVersion: 1, generatedAt: now().toISOString(), dataDate, seriesStart, baselineStart, baselineEnd,
    source: {
      name: 'Wikimedia Analytics API', license: 'CC0 1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      url: 'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html',
      policyUrl: 'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html', topUrl: topUrl(dataDate),
    },
    method: METHOD,
    coverage: { requestedDate, fallbackDays, topListCount: topArticles.length, candidateCount: candidates.length, articleCount: articles.length, failures },
    articles, uncomparedArticles,
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--date')) throw new Error('Usage: node collect.mjs [--date YYYY-MM-DD]');
  const snapshot = await collectSnapshot({ requestedDate: args[1] });
  const outputPath = process.env.WIKI_INTEREST_OUTPUT_PATH || fileURLToPath(new URL('./public/data/snapshot.json', import.meta.url));
  await atomicJson(outputPath, snapshot);
  console.log(`Saved snapshot for ${snapshot.dataDate}: ${snapshot.articles.length} comparable articles, ${snapshot.uncomparedArticles.length} incomplete histories shown separately, ${snapshot.coverage.failures.length} comparison exclusions.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.status ? `Collection failed: HTTP ${error.status}` : 'Collection failed; existing snapshot preserved.'); process.exitCode = 1; });
}
