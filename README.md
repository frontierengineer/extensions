# Frontier Application Registry

The open application registry for [Frontier](https://frontierengineer.com). Anyone
can publish; nobody hand-reviews your listing. Trust comes from automation, not
gatekeeping:

- **Identity is your GitHub identity.** An application id is `<owner>/<name>`,
  where `<owner>` is the GitHub account or org that owns the source repo.
  Impersonating a publisher means compromising their GitHub account. There are
  no registry accounts and no publish tokens to leak.
- **Every version is scanned before it's installable.** A version enters
  [`index.json`](index.json) only after the automated scan (structure checks,
  secret detection, size caps, pattern flags, and an LLM review of the source)
  passes — updates included, not just first releases.
- **Artifacts are hash-pinned.** The index records the sha256 of the exact
  tarball that was scanned. Clients verify it at install time, so an artifact
  can't be swapped after scanning.
- **The kill switch is [`blocklist.json`](blocklist.json).** Frontier instances
  poll it; a blocklisted application is barred from install and auto-disabled on
  machines that already have it. Removed ids are reserved forever — a banned
  name can't be re-registered.
- **Trust signals, not gates.** The Frontier marketplace UI shows what a
  package ships (host-side server code vs UI-only), its dependency count, scan
  flags, repo, and stars — and asks for explicit consent before install.

## How it works

```
publish:  your repo ──release──▶ indexer scans ──▶ index.json (sha256-pinned)
install:  Frontier ──reads──▶ index.json ──fetch+verify──▶ your release tarball
moderate: report ──▶ admin adds to blocklist.json ──▶ fleet auto-disables
```

1. **[`listings/`](listings/)** — one file per application:
   `listings/<owner>/<name>.json` containing `{"repo": "<owner>/<repo>"}`.
   Added via PR; a bot validates (namespace ownership, name rules, typosquat
   distance, repo existence) and **auto-merges** — no human review.
2. **[`index.json`](index.json)** — generated. The indexer polls every listed
   repo's GitHub releases (every 30 minutes), scans unseen versions, and adds
   the ones that pass with a pinned hash. Rejections are recorded per
   application with the reason, so publishers can see why a version didn't land.
3. **[`blocklist.json`](blocklist.json)** — hand-edited by registry admins in
   response to reports. PRs touching it never auto-merge.

## Publishing

See [PUBLISHING.md](PUBLISHING.md). Short version: put your application in a
public GitHub repo, cut a release `vX.Y.Z` with a single `.tgz` asset of the
application tree, and PR one small JSON file into `listings/<you>/<name>.json`.
Updates after that are just new releases — no further PRs.

## Reporting a malicious application

Open an issue with the `abuse` label, or email security@frontierengineer.com.
Confirmed-malicious applications are blocklisted (which disables them fleet-wide
within the polling interval), their publisher is banned, and the removal is
recorded publicly in the blocklist with a reason.

## Threat model, stated plainly

This registry accepts that **a malicious application can be listed and can run
on installing machines until it is reported** — the same line the VS Code
Marketplace accepts. What it refuses: install-time code execution (Frontier
installs third-party deps with `--ignore-scripts`), silent artifact swaps
(hash pinning), unscanned updates (every version is scanned), name
reclamation after removal, and slow takedown (blocklist propagates to clients
in minutes). Install consent in Frontier always tells you whether a package
ships host-side code with full machine access.
