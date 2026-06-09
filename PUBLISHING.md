# Publishing an extension

Publishing is self-serve and unreviewed-by-humans. Three steps, the first two
of which you only do once.

## 1. Put your extension in a public GitHub repo

The repo must be owned by the account or org you'll publish under — the
listing namespace and the repo owner must match; that's how the registry knows
the publisher is really you.

Repo layout = extension layout (the same tree Frontier runs from
`extensions/<id>/`):

```
extension.json        required: {"displayName": "...", "defaultColor": "#rrggbb", "description": "..."}
ui/index.tsx          browser UI capability (optional)
ui/package.json       its deps (optional — fewer is better, zero is best)
mcp/index.ts          host-side MCP tools (optional — full host access)
hooks/index.ts        host-side hooks (optional — full host access)
workspace/index.ts    workspace provider (optional — full host access)
runtime/index.ts      worker runtime (optional)
```

Notes that affect whether your versions pass the scan:

- **No `node_modules/`, `data/`, or `.git/` in the tarball.**
- **No secrets anywhere in the tree** — a leaked token fails the scan.
- **Prefer zero dependencies.** Frontier installs third-party extension deps
  with `npm install --ignore-scripts`, so packages relying on install scripts
  will not work. Vendor what you can.
- Size caps: 25 MB compressed, 100 MB unpacked, 5000 files.

## 2. List it (one-time PR, auto-merged)

Add `listings/<owner>/<name>.json`:

```json
{ "repo": "<owner>/<repo>" }
```

`<name>` is the extension id users see (lowercase, hyphens). It doesn't have
to equal the repo name. Open a PR from the GitHub account that owns the
namespace (or a public member of the org). A bot validates and merges — if it
fails, the comment tells you exactly why.

## 3. Release a version (repeat for every update)

Tag a release `vX.Y.Z` (no prereleases) carrying **exactly one asset** ending
in `.tgz` or `.tar.gz` — a tarball of the extension tree with `extension.json`
at its root:

```sh
tar -czf extension.tgz --exclude .git --exclude .github --exclude node_modules --exclude data .
gh release create v1.0.0 extension.tgz --title "v1.0.0"
```

Or automate it — drop this in `.github/workflows/release.yml` and publishing
becomes `git tag v1.0.1 && git push --tags`:

```yaml
name: release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: tar -czf extension.tgz --exclude .git --exclude .github --exclude node_modules --exclude data .
      - run: gh release create "$GITHUB_REF_NAME" extension.tgz --title "$GITHUB_REF_NAME"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The indexer polls every 30 minutes. Your version is scanned and — if it
passes — appears in `index.json` with its sha256 pinned. If it's rejected, the
reason is recorded in your extension's `rejected` list in the index.

**Why an uploaded asset and not the auto-generated source tarball?** GitHub
does not guarantee byte-stability of generated source archives, and the
registry pins the exact bytes it scanned. Release assets are immutable.

## Sharing without the registry

The registry is the discoverable path, not the only one. Frontier can install
from any tarball URL (with a stronger warning, like VS Code's install-from-
VSIX), and any installed extension can be exported as a tarball from the
Extensions view. Hand someone the file if you like.
