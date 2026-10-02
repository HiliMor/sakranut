# Standalone repository — 2026-10-02

Sakranut was extracted as a clean, standalone code snapshot. The original experiments and their Git history remain intact in their private repositories; this repository does not import that history or their unrelated source/data.

## Included

- Sakranut frontend, measurement collector, runtime and health logic.
- Its 11 existing test files, with imports adjusted to this repository's root.
- Its dedicated private deployment configuration and reviewed sample data.
- Standalone Node 24 package scripts and a reproducible dependency lockfile.

The collector contact URL now points to this repository. No measurement or comparison rule changes are intended by extraction.

## Unchanged infrastructure

Repository organization does not move `/var/lib/wiki-interest` or `/opt/wiki-interest`, replace the deployed release, stop timers, or reconfigure alerts. The live service uses bundled releases rather than pulling from Git on each run. The SSH tunnel remains private on local port 5175. Existing deployment names retain `wiki-interest` for continuity.

The code's new contact URL takes effect on the next normal, verified deployment. There is no need to redeploy solely to reorganize source control. The previous release and data remain available for recovery.

## Development

This checkout uses port 5176 to avoid interrupting the earlier preview process. Future Sakranut changes belong here. The old source copy is historical, not a second active development target.

Public code does not authorize public site hosting. Keep runtime history, credentials and unreviewed context research out of Git and outside served files. No secrets or private legacy datasets were intentionally included in the extraction.
