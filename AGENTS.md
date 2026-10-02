# Sakranut working rules

- Canonical project: this repository; do not implement Sakranut changes in the older news experiments.
- Never pay, subscribe, or activate billable API usage without explicit user approval.
- Keep the existing website private unless the user separately authorizes publication. Public code is not public hosting permission.
- Never commit secrets, SSH keys, Healthchecks URLs, runtime history or context research drafts.
- The leading overview belongs to the snapshot; article navigation must not replace it. Preserve list state on detail close.
- Preserve unknown measurements as unknown. Do not invent missing days or causal explanations.
- Context research is a separate draft-only layer. No worker may promote its own output into `public/data/context.json` or change `reviewStatus` to `approved`.
- Read source bodies when accessible, record publication/event dates separately, distinguish source claims from observations, and abstain when evidence is insufficient. Do not bypass blocks or paywalls.
- Preserve server runtime paths, service names and alert configuration during repository work. No legacy-news service changes are authorized by work here.
- Use feature branches with the `codex/` prefix. Run `npm test` and `npm run build`; distinguish automated checks, browser checks, code pushed and deployment.
