# History and measured weekly patterns

This iteration makes the archive useful for a bounded longitudinal pilot. It is not an all-Wikipedia anomaly detector, a causal explanation layer or a publication approval.

## Preparation and import are separate

1. Start in a dedicated temporary stage. Optionally copy validated original editions into `seed-history/` there.
2. Prepare seven completed UTC days first. Fetch each missing day's own top list, select its first 30 eligible titles, and request overlapping per-title histories once where possible.
3. Inspect coverage and gaps. A prepared day must pass the unchanged 75% complete-history gate. Missing observations are not zero, and no prior-day fallback is allowed.
4. If the pilot passes, extend the same stage to 30 days. This is a cap on one operation, not a lifetime limit of the archive.
5. Import a reviewed stage on Linux under the existing runtime lock. Validate all staged editions before taking the lock; do no network work while importing. Add only missing dates, retain existing editions, merge the private series cache, and explicitly rebuild safe archive projections/index. Do not write the latest snapshot, collection status, runner state or reviewed contexts.

```bash
npm run history:prepare -- --stage /absolute/dedicated-stage --end YYYY-MM-DD --days 7
npm run history:prepare -- --stage /absolute/dedicated-stage --end YYYY-MM-DD --days 30
npm run history:import -- --stage /absolute/dedicated-stage --runtime /var/lib/wiki-interest
```

Do not use `npm run collect -- --date OLD_DAY` to populate the live archive: its default output replaces the local latest snapshot. Preparation files/cache are private, not repo artifacts. A rate-limit stop preserves successful checkpoints. Honor publisher backoff before resuming.

Retrospective editions retain `generatedAt` as the actual retrieval time and add `collectionOrigin: retrospective`. Original saved editions are neither re-dated nor relabelled.

## Active tracking cohort

- Titles are admitted only through validated daily top-list samples from the most recent 30 calendar days. Even comparison failures remain known cohort members, with unknown measurements represented by an empty or partial series.
- Continue fetching measured daily observations after a title leaves today's top 30, until 30 days after its last sampled appearance. Never infer a viewing decline or zero from missing top-list membership.
- Reuse each saved 35-day series and the private cache. On normal future checks, request only an unmeasured tail. Bound each run to 80 sequential requests and stop starting requests after 60 seconds. An already-started request/retry can complete later. Prioritize the oldest checked series, then more recently sampled titles. Expected small-cohort operation is not an SLA or a guarantee of complete coverage after every run.
- Publisher `Retry-After` stops the entire queue and persists a retry time. Other series failures defer that title by three hours. The existing three-hour collector schedule also retries pending series; no new timer, paid service or AI is required.
- Keep this layer optional and separate from measurement success/alerts. A failed tracking product cannot turn a valid daily snapshot into an error or advance `lastSuccessAt`.
- Export only validated title/sample-date/observation fields to `tracks.json`, never cache internals, retry timestamps or operator notes. Gzip JSON in the private server and let the browser revalidate its ETag rather than redownloading unchanged month-sized data.

The archive retains old editions; the active tracking/weekly view is bounded to the last 30 days. A full historical index of weekly findings beyond that window is not implemented.

## Weekly patterns

Require all 35 daily observations for the selected date and a baseline of at least 20. Use the median of the preceding 28 days, held fixed for the final seven days.

- **Persistent elevation:** at least three consecutive final days at `max(2 × baseline, 100)` views or more. This can coexist with a decline from a previous peak; it is not the discovery tab's stricter `sustained` label.
- **Recovered high point:** a weekly peak at least `max(3 × baseline, 500)` views, no later than the fifth day of the week, followed by the last two days below the elevation threshold.
- Rank separately by the sum of `max(views − baseline, 0)` across the week; show at most two titles per group. Ties use title order. Sparklines show 14 measured days in independent scales; details expose the numbers/table and verification links.
- No significance, seasonal adjustment, unique-reader count, geographic inference, causal explanation, inferred rank change or guaranteed recurrence.
- When selecting an older day, exclude titles first sampled later and observations after the selected day. Open/close details without replacing the daily leader, query, sort, scroll or focus. The source JSON for a followed title is the tracking product, not a daily snapshot that no longer contains it.

## Acceptance and remaining launch work

Automated cases cover own-day sample selection, cache reuse, gaps, quality gates, additive import, rate-limit backoff, bounded requests, observed zero, incomplete/low-baseline abstention, future-data exclusion, optional-product isolation and source links. Browser verification must cover actual archive and followed-title details, responsive widths and keyboard/return behavior after private deployment.

This work does not claim user validation, full screen-reader accessibility, tested failure/recovery emails, an off-host backup or public publication. Before launch: run the already documented reader study, a future-day operational soak, recovery/backup checks and a scoped public-hosting review. Do not buy a domain, activate a billable API or open public server ingress without separate approval.
