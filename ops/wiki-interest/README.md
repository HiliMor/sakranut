# Sakranut private daily runtime

Operational runbook for Sakranut. Do not apply these commands to the RSS/news project, its databases, services or existing heartbeat checks.

**Repository extraction, 2026-10-02:** the canonical code is now `HiliMor/sakranut`. The extraction does not install a server release or change runtime paths, timers, alerts or private access. Historical verification records below predate extraction; their test totals include the old repository. New development uses port 5176. Context research tools are local, draft-only and not scheduled on the server.

## Current verified release — 2026-10-03

The history/patterns iteration is being verified separately. Its staged seven-day pilot has been extended to 30 dates (September 3–October 2), with 400 unique sampled titles. Only 28 missing dates are eligible for additive import; original October 1–2 editions and the live snapshot must stay byte-identical. See [the history protocol](../../docs/HISTORY_PATTERNS.md). A staged report is not deployment evidence.

### Previous archive release

Archive and identification: release `20261003T165446Z-archive` is active, built from source `a92ade662284234ed2b0c616d2873c6c88cc2b9d`. It adds a day selector, previous/next available day, explicit return to latest, stable historical selection during refresh, and retrieval-dated Hebrew Wikidata identification. The two available days were October 1–2; 40 of the 43 unique archived/current titles had descriptions, including 27 of the 30 current-day titles. Three missing descriptions were negatively cached; there were no pending titles after the follow-up check. No descriptions were invented or used as surge explanations.

Local suite: 163 passing, five Linux-specific skips. Isolated Linux suite: 167 passing, one non-Linux-only skip. Build and diff check passed. Browser QA with isolated server data covered 1280/390/320 widths, selected-date links, search/sort retention, keyboard details/Escape, explicit return focus and manual refresh while viewing history. The deployed private tab confirmed both dates, their different leaders, identification, the corresponding Wikidata QID link and historical JSON detail link. No console errors or horizontal overflow were observed. These checks are not a screen-reader or physical-device certification.

Both services succeeded, both timers remained active with unchanged unit hashes, and the listener stayed `127.0.0.1:4174`. Snapshot SHA-256 stayed `07f269c34b3dce413208256084f8f4f5307eafd4d4bfb8318a996a7505b77358`; reviewed context stayed unchanged. Nginx was deliberately extended only with the two new explicit products and date-shaped archive projection route; its new hash is `d8b284906fb27b9726174298100b59da9fb9f5017da08d2750ffafe0290aa397`. All seven denied routes, an unavailable date and an impossible date returned 404. The dedicated alert configuration was retained, not re-created or printed.

A completed follow-up no-op made zero description requests and left snapshot, archive-index and description-file hashes identical. `lastSuccessAt` remained `2026-10-03T03:21:38.993Z`; `checkedAt` advanced to `2026-10-03T16:57:46.183Z`, with separate health check `16:57:46.335Z`. The previous overview release is retained for rollback. New archive/description products and private cache are additive runtime files, never committed. No public hosting, new timer, AI service or payment was introduced.

### Previous same-day releases

Compact overview: release `20261003T160106Z-overview` was deployed from source `2b4647e516998849cf700f33a77da459541e19a8`. It combines the monthly-baseline leader and separately dated daily comparison in one responsive overview, shortens the introduction and uses compact ranked rows. Approved context is expandable; a missing explanation no longer occupies an empty overview block. Detail content, measurement rules and collection schedules are unchanged.

Local tests passed (144 passing, five Linux-specific skips), as did the build and isolated Linux suite (148 passing, one non-Linux-only skip). Browser checks covered 1280, 611 and 390 pixel widths, sorting, search, partial histories in the popular ranking, keyboard detail opening, Escape close and restored opener focus/search/sort. The deployed private browser confirmed October 2, automatic daily status, the new assets and stable overview leader after opening a daily-change detail. At 1280 pixels, the data starts at 252px and discovery at 717px; the prior layout started them at 448px and 1397px. Nine compact rows fit in approximately one discovery viewport. No console errors or horizontal overflow were observed. These checks are not a screen-reader or physical-device certification.

Snapshot, reviewed context, Nginx configuration and all four unit-file hashes were identical before and after deployment. `lastSuccessAt` stayed at `2026-10-03T03:21:38.993Z`; `checkedAt` advanced to `2026-10-03T16:02:18.186Z`. Both services succeeded and both timers remained active. The listener remains loopback-only and all four denied paths returned 404. The previous weekday release remains available for rollback; no public hosting or paid service was added.

Weekday-label follow-up: release `20261003T144013Z-weekday` was installed from source `06e172ece9949524fcd71634f3607f704df49413`. The private browser showed `נתוני יום שישי, 2 באוקטובר 2026`; the weekday is derived from the measurement's UTC calendar date. Local tests (144 passing, five Linux-specific skips) and build passed. Snapshot SHA-256 remained identical to the daily-briefing release below, both timers were active, both services succeeded, and the browser reported no errors or horizontal overflow.

Release `20261003T142909Z-daily-briefing` was installed from source commit `8b7091ae1f84321b02f6333e5670175fea66d7f3` after user approval. It adds the observed daily-change summary, the same daily comparison in article details, and a user-initiated external article search. The private site at local port 5175 reads the server's live snapshot/status routes; port 5176 remains development with a dated local sample.

The standalone suite passed locally (144 passing, five Linux-specific skips) and in the isolated Linux staging directory (148 passing, one non-Linux-only skip). The build passed. The installer completed and both collection/health services succeeded; both timers remained active with the same unit-file hashes. Nginx configuration and reviewed context hashes also stayed unchanged. The listener remains `127.0.0.1:4174`, and all four denied paths in the privacy checks returned 404.

Post-deployment snapshot SHA-256 is `07f269c34b3dce413208256084f8f4f5307eafd4d4bfb8318a996a7505b77358`, identical to the pre-deployment snapshot. Its measurement date is `2026-10-02`, with 26 complete histories and four separately displayed partial histories. `lastSuccessAt` stayed at `2026-10-03T03:21:38.993Z`; the successful deployment check advanced `checkedAt` to `2026-10-03T14:29:38.153Z`. All 30 articles have an observed pair for October 1–2. The largest daily changes are Jacob Amidror −16,207, Oman −4,998, and Air Crash Investigation −3,647 views.

The private browser loaded the new asset, displayed October 2 and automatic daily status, and showed the October 2 vs October 1 briefing. Opening/closing a daily item restored focus and kept the overview leader. Its external search uses the current measurement date. No browser console errors or warnings were observed. The previous release `20261002T115916Z-navigation` remains available for rollback. Future daily snapshots continue to update the page and computed briefing through the existing hourly/return/manual browser checks; this deployment does not claim an additional future day has already been published.

## Historical verification record (before repository extraction)

**Fixed overview navigation, 2026-10-02:** release `20261002T115916Z-navigation` is active. The overview remains the current snapshot's leader; all article exploration uses one detail dialog with its own chart and sticky return controls. Opening/closing retains sort, query, shown-card limit, opener focus and page position. Automatic display updates are skipped while the dialog is open, including already-started results; collection is unaffected. Live browser verification reproduced the sustained-interest → Sami Abu Shehadeh → return flow: Jacob Amidror remained the leader and focus returned to Sami's card. The new production asset loaded without console errors. Local suite: 258 passed, five platform-specific skips; both builds passed. Snapshot bytes and `lastSuccessAt` stayed unchanged; the collector check advanced to 12:00:14 UTC. Both services succeeded, both Sakranut and all eight legacy timers remained active, the listener stayed loopback-only and four denied paths returned 404. No public access or new service was introduced.

**Accessibility and discovery follow-up, 2026-10-02:** release `20261002T114420Z-a11y-ux` is active. It adds display pause/manual refresh, unified popular ranking/search, sort-specific metrics, readable responsive axes, stronger contrast, a matching 14-day table and focus handling. Full local suite: 251 passed and five Linux-specific skips; both builds passed. Snapshot SHA-256 stayed `667b7d02bcb239ad0be2d08965273a8168ade60fce109d442b537bb8717f3783`; `lastSuccessAt` remains 10:43:19 UTC. The completed collector check advanced to 11:45:11 UTC; both services succeeded, both timers and all eight legacy timers remained active. Listener remains loopback-only and all four denied routes returned 404. No data methodology, collection schedule, news service or alert configuration changed. See the experiment README for browser checks and remaining accessibility verification limits.

**Hourly browser check, 2026-10-02:** release `20261002T112246Z-hourly-poll` is active. Initial-load and visibility-return checks remain; the visible-tab interval is now one hour. Future-clock tolerance remains five minutes, independent of that interval. The server snapshot stayed byte-identical and `lastSuccessAt` stayed at 10:43 UTC; collection and health services succeeded, both timers remain active and the listener remains loopback-only. The deployed browser loaded the new asset and hourly explanatory text without console errors. Full local suite: 229 passed, five platform-specific skips; the experiment build passed. The separate accessibility/UX audit documented unresolved findings in the experiment README; this deployment fixes polling frequency only, not those findings.

**Earlier UI-only follow-up, 2026-10-02:** release `20261002T110542Z-ui-polish` was installed. Collection metadata is collapsed by default; ordinary displayed partial histories have no top warning, while omitted candidates and runtime/fetch/staleness problems retain a visible notice. Deployment left the measurement snapshot byte-identical and kept `lastSuccessAt` at 10:43 UTC; only the completed check advanced to 11:06 UTC. Both services succeeded and timers remained active on the same schedule, with the listener still loopback-only. Browser verification confirmed the compact date/status, expandable live metadata and no console errors. Full local suite: 228 passed, five platform-specific skips; both builds passed. This change did not alter collection, comparison rules or the daily publication gate.

**Earlier verification on 2026-10-02:** release `20261002T104146Z-partial-history` was installed on the existing host. Both timers were enabled; collection and health services completed successfully. The 10:43 UTC publication contains 24 comparable articles and six separately displayed incomplete histories for 2026-10-01. All six have measured-day counts; no candidate is entirely omitted in this snapshot. A repeated post-upgrade run left snapshot bytes and `lastSuccessAt` unchanged. The earlier same-day snapshot is retained under `history/revisions/`; the initial code release also remains available for rollback.

A separate Sakranut Healthchecks check has a one-hour period, 30-minute grace and the existing email integration enabled. Its protected server configuration is in place. The Healthchecks UI confirmed **Up** and an HTTPS POST from the server with `wiki-interest: healthy; data 2026-10-01`. Failure/recovery email delivery has **not** been exercised. `monitoring.configured: true` alone confirms a syntactically valid dedicated ping URL, not delivery of a failure email.

Verification included: the focused suite passed on Linux, including locking and four isolated deployment rollback cases; both builds passed locally, and the full local suite had 225 passing tests (five Linux-required cases verified separately). The live private browser showed 24 comparable plus six partial-history cards, correctly found a partial-only search, and displayed automatic daily status. The service remains loopback-only on `127.0.0.1:4174`; source and historical files are outside its explicit public-file routes. No news-service configuration or monitoring check was changed.

This deployment is private, on the existing Linux host. It does not open cloud ingress, expose a new public listener, add a domain, publish a public website or authorize paid services.

## Isolation and files

| Location | Purpose |
| --- | --- |
| `/opt/wiki-interest/releases/<release-id>` | Immutable code release and built `site` directory. |
| `/opt/wiki-interest/current` | Symlink to the selected release. |
| `/var/lib/wiki-interest/public/snapshot.json` | Last validated measurement snapshot. |
| `/var/lib/wiki-interest/public/status.json` | Public-safe runtime state, dates, counters and monitoring boolean. |
| `/var/lib/wiki-interest/public/archive.json` | Validated available-day index, published after its snapshot products. |
| `/var/lib/wiki-interest/public/archive/YYYY-MM-DD.json` | Whitelisted measurement projection, accessible only through a date-shaped route. |
| `/var/lib/wiki-interest/public/descriptions.json` | Optional Hebrew Wikidata identifiers/descriptions with retrieval timestamps. |
| `/var/lib/wiki-interest/description-cache.json` | Private positive/negative metadata cache, pending titles and retry time; not web-served. |
| `/var/lib/wiki-interest/history/YYYY-MM-DD.json` | Validated daily snapshots; not web-served. |
| `/var/lib/wiki-interest/history/index.json` | Available and missing dates; no automatic backfill. |
| `/var/lib/wiki-interest/runner-state.json` | Last completed collector check and successful publication; not web-served. |
| `/var/lib/wiki-interest/runtime.lock` | Kernel-managed `flock` lock shared by collection and health. Do not delete to unlock. |
| `/etc/wiki-interest/healthchecks.env` | Optional dedicated secret configuration; root:www-data, mode 0640. |
| `/etc/nginx/sites-enabled/wiki-interest-private.conf` | Dedicated loopback-only server on port 4174. |
| `/var/backups/wiki-interest-config` | Previous Sakranut configuration and unit files retained by the installer. |

The `wiki-interest` system user can write runtime data, not the release or the home directory. `www-data` can serve the explicitly configured public files. Healthchecks secrets never belong in source control, browser JSON, terminal output or this document.

`context.json` is a reviewed static file in the release's `site/data` directory, not automatically generated by the collector. Only approved records with an exact article title and measurement date are displayed. Source dates and HTTPS links are required; a possible explanation is not a causal finding.

## Schedule and failure semantics

- Collector: `wiki-interest-collect.timer`, `00/3:20 UTC` — 00:20, 03:20, 06:20, 09:20, 12:20, 15:20, 18:20 and 21:20, plus up to 90 seconds of randomized delay. `Persistent=true` catches a missed timer after a host restart.
- Daily publication is conditional on upstream availability and validation, not guaranteed at a fixed wall-clock time. The first attempt for a new UTC day is at 00:20 UTC the following day (03:20 in Israel during daylight saving time; 02:20 in standard time). A later same-day check does not imply newly measured data. Convert the live timer output with `Asia/Jerusalem`, not the host's timezone, when reporting the next attempt to the user.
- Independent health check: `wiki-interest-health.timer`, every hour at `:45 UTC`, plus up to 45 seconds of randomized delay. It does not collect measurements.
- The requested data day is strictly yesterday in UTC. The scheduled runner uses `maxFallbackDays: 0`; the manual developer collector's historical fallback is not used.
- A published yesterday snapshot in the current format makes later collector checks a no-op for measurement requests and public measurement publication. Runner status and the history index may change. Optional identification metadata can retry pending work or expired cache entries, but `lastSuccessAt` must not advance on a no-op.
- Partial-history format upgrade: `uncomparedArticles` is an additive v1 array. An older same-day snapshot without this field is re-collected once; the prior version is retained under `history/revisions/` before replacement. A failed upgrade preserves the old published snapshot. Partial cards remain in `coverage.failures` as **comparison exclusions**, so the unchanged 75% gate and `articleCount` refer only to full-history articles. The UI subtracts separately displayed partial records before reporting articles not shown at all.
- Unavailable or insufficient prior-day data preserves the last good snapshot and reports `waiting`; invalid/network data errors report `error`. Publication uses atomic file replacement and a shared kernel lock.
- Data age of at least three UTC calendar days is `stale`. A completed collector check older than six hours is also `stale`, even if the health service still runs hourly.
- `checkedAt` is the collector check time. Optional `healthCheckedAt` is separate and must never make a stopped collector look fresh.
- The UI independently withdraws its automatic-update confirmation once `checkedAt` is more than six hours old, even if the health service stopped and left a formerly healthy status file behind.
- The UI checks on initial load, upon visibility restoration, and every hour only while visible. Hidden or user-paused tabs skip automatic checks; pause also prevents an in-flight automatic result from applying. An open detail dialog also blocks automatic checks and applying already-started responses, preserving the reading and return context until a later check after closing. The data disclosure offers a manual check while paused and a resume control. These controls do not affect server collection. These are daily measurements, **not realtime traffic**. Failed fetches retain valid displayed data with a warning. Status timestamps retain an independent five-minute future clock-skew tolerance; hourly polling does not relax validation.
- History is retained locally. Missing dates are listed, not synthesized. This is not an off-host backup or a completed backup/restore drill.
- The collector also publishes the safe archive and optional identification metadata under its existing lock. Archive entries are validated against filename/date and the measurement schema, with unknown nested fields omitted. The index is published last. Same-edition archive exports are reused, rather than rescanning history every three hours. Private history, revisions and cache files have no web route.
- Identification uses `pageprops.wikibase_item` and Hebrew `pageterms.description` from the official Hebrew Wikipedia WikibaseClient API. No redirects, fuzzy-name search, page bodies or AI. Titles and QIDs must match the requested article. A new/pending/current-expired description can trigger up to two sequential requests of at most 20 titles, with `maxlag=5`, an identifying User-Agent, a 12-second timeout and 200ms spacing. The seven-day cache includes missing descriptions; older editions retain retrieval-dated identification, not historical claims. HTTP/API errors defer retries by at least one hour and honor longer `Retry-After`; cached descriptions survive. This optional layer is not a measurement-health gate and does not approve news context.
- Browser data/status refresh remains hourly/return/manual. While viewing an archived day, the latest snapshot/status can update separately but the displayed day, leader, lists, detail source link and context-date match remain historical until an explicit return. Selection failures retain the displayed day; stale selection responses are ignored. The UI disables article exploration while a date is loading and restores keyboard focus when a boundary/return control becomes unavailable.

## Install a release

Prerequisites: Linux, Node.js 24, util-linux `flock`, existing Nginx, working outbound HTTPS to Wikimedia, and administrative access. This runbook does not authorize package purchases or changes to existing news services.

Build with `npm run build` locally. Copy the resulting `dist/` into the bundle's `app/site/`. The reviewed bundle must contain:

```text
bundle/
  app/
    package.json
    collect.mjs
    data-lib.mjs
    runtime-lib.mjs
    run-daily.mjs
    health.mjs
    reading-products.mjs
    archive-products.mjs
    description-products.mjs
    tracking-products.mjs
    backfill.mjs
    src/ui-lib.js
    src/archive-state.js
    src/identification.js
    src/tracking-lib.js
    site/                  # built experiment, including reviewed data/context.json
  ops/
    install.sh
    nginx-private.conf
    wiki-interest-collect.service
    wiki-interest-collect.timer
    wiki-interest-health.service
    wiki-interest-health.timer
```

Inspect the exact bundle and release ID before running the installer as root. The release ID format is `YYYYMMDDTHHMMSSZ-<4-to-40-character-suffix>`. The installer refuses to overwrite an existing release directory.

```bash
sudo bash /absolute/bundle/ops/install.sh /absolute/bundle RELEASE_ID
```

`RELEASE_ID` is a placeholder: replace it with the inspected valid ID, not a guessed existing directory. The installer records the previous link/configuration, validates Nginx before reloading, starts the new collector/health services and enables their timers. A successful copy or build alone does not prove operation; complete the checks below. On a first-day upstream delay without a valid snapshot, the installation may require another collector run before verification can pass.

## Private access

Use the SSH host and key already approved for this server; `USER@SERVER` below is a placeholder.

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:5175:127.0.0.1:4174 USER@SERVER
```

Open `http://127.0.0.1:5175/` on that computer. Local development remains separate on port 5176. Do not change the binding to `0.0.0.0`, open port 4174 in OCI or add a public proxy without a separate publishing decision.

After timers are actually activated, collection and health checks continue with the laptop closed. The SSH tunnel and local viewing do not: reconnect the tunnel when the laptop returns. A closed tunnel is not evidence of a failed server.

## Verify operation

Run on the server:

```bash
readlink -f /opt/wiki-interest/current
sudo nginx -t
systemctl is-active wiki-interest-collect.timer wiki-interest-health.timer
systemctl list-timers wiki-interest-collect.timer wiki-interest-health.timer --all --no-pager
systemctl show wiki-interest-collect.service wiki-interest-health.service -p Result -p ExecMainStatus
sudo journalctl -u wiki-interest-collect.service -u wiki-interest-health.service -n 60 --no-pager
curl --fail --silent --show-error http://127.0.0.1:4174/data/status.json
```

Confirm that `dataDate` is a completed UTC day; `checkedAt` is recent; the served snapshot date matches status; `coverage.articleCount` matches the actual articles; and `lastSuccessAt` is at or after the snapshot's `generatedAt`. An inactive **oneshot service** between runs is normal; check its result and the active timer instead.

For a no-op check, only after today's target (yesterday UTC) is successfully published:

```bash
sha256sum /var/lib/wiki-interest/public/snapshot.json
curl --fail --silent --show-error http://127.0.0.1:4174/data/status.json
sudo systemctl start wiki-interest-collect.service
sha256sum /var/lib/wiki-interest/public/snapshot.json
curl --fail --silent --show-error http://127.0.0.1:4174/data/status.json
```

Expect an identical snapshot hash and unchanged `lastSuccessAt`, a newer `checkedAt`, and a journal entry ending `unchanged`. Do not run this across UTC midnight: a new target day legitimately requires collection.

### Privacy checks

```bash
sudo ss -ltnp 'sport = :4174'
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:4174/history/index.json
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:4174/runner-state.json
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:4174/data/runner-state.json
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:4174/.env
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:4174/data/archive/index.json
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:4174/data/archive/revisions/2026-10-01.json
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:4174/data/description-cache.json
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:4174/data/tracking-cache.json
```

The listener must be `127.0.0.1:4174`, not all interfaces; all eight denied paths must return 404. The archive index, tracking product and validated available date routes should return 200; an unavailable date should return 404. Verify `Content-Encoding: gzip` for JSON when requested, and an unchanged-product ETag conditional request returns 304. Confirm that existing public news listeners/routes and existing collector timers are unchanged. The loopback listener does not by itself audit the entire host's network configuration.

## Dedicated external alerts — verification pending

The separate Sakranut check is configured for a one-hour period and 30-minute grace, with the existing email integration enabled. Do not create a duplicate, reuse RSS/candidates/video checks, upgrade or pay without explicit approval. A configured check and enabled integration are not evidence that a notification reached the recipient.

The dedicated HTTPS `hc-ping.com/<UUID>` endpoint belongs only in `WIKI_INTEREST_HEALTHCHECK_URL` in `/etc/wiki-interest/healthchecks.env`, owned by root:www-data with mode 0640. That protected configuration has been prepared. Never print or paste the value into a log. No secret is needed for ordinary collection or private viewing.

Then run `sudo systemctl start wiki-interest-health.service` and verify a successful ping in the separate check. Under an explicitly coordinated test, verify failure email and recovery before describing alerts as active. `waiting` with fresh data/checks is not a failure; `error` or `stale` sends `/fail`. If the VM itself stops, only an already configured external missed-heartbeat check can notice its silence.

Until server deployment and these checks pass, describe code, configuration, actual heartbeat delivery and notification verification as separate states, not “we will receive an alert.”

## Recover without touching the legacy project

1. Inspect Sakranut unit results, logs, current release link and the explicit runtime paths first. Keep the last valid snapshot and history. Do not delete a kernel lock file to recover a dead process: `flock` releases automatically when its owner exits.
2. A transient upstream problem normally needs no rollback. Leave the last good data visible and let the next scheduled check retry; run the collector manually only when a fresh check is useful.
3. For a bad code release, resolve and record the exact previous release using the known release list and installation record. Confirm it contains `run-daily.mjs`, `health.mjs` and `site/index.html`. Stop only the two Sakranut timers and any active Sakranut services, not Nginx or any news units.
4. Replace `/opt/wiki-interest/current` atomically with a symlink to that verified previous release. Preserve both release directories and `/var/lib/wiki-interest`; switching code is not a request to reset or delete data. A known example, after replacing `VERIFIED_PREVIOUS_RELEASE` and confirming `/opt/wiki-interest/rollback-selected` does not already exist:

   ```bash
   sudo systemctl stop wiki-interest-collect.timer wiki-interest-health.timer
   sudo systemctl stop wiki-interest-collect.service wiki-interest-health.service
   sudo ln -s releases/VERIFIED_PREVIOUS_RELEASE /opt/wiki-interest/rollback-selected
   sudo mv -T /opt/wiki-interest/rollback-selected /opt/wiki-interest/current
   ```

5. If the release also changed Sakranut unit or Nginx configuration, inspect the exact matching backups in `/var/backups/wiki-interest-config` before restoring only those files. Run `systemctl daemon-reload` for changed units and `nginx -t` before any Nginx reload. Never restore a whole global configuration tree or alter legacy news configuration.
6. Re-run only `wiki-interest-collect.service` and `wiki-interest-health.service`, inspect exit results, then start the two timers. Repeat the JSON, private-listener, blocked-path and browser checks before declaring recovery complete.

Code rollback does not reverse a data-schema change. If an older release cannot read the retained data, stop and inspect compatibility; do not replace the runtime directory or delete history. Recover an individually validated historical snapshot only after retaining the current files and following a reviewed data-recovery procedure.
