'use strict';
// Build index.json from the listings: poll each listed repo's GitHub
// releases, scan every version the index hasn't seen, and pin its sha256.
// Runs on a schedule and after every listings/blocklist change. Idempotent —
// already-scanned versions (accepted or rejected) are never re-downloaded,
// so a run with no new releases is a no-op.
//
// Versions enter the index ONLY through this scan. Clients install only
// index-listed versions and verify the pinned hash, so a publisher cannot
// swap an artifact after it was scanned.

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  ghApi, downloadCapped, sha256, loadListings, loadBlocklist, SCAN_LIMITS,
} = require('./lib');
const { scanTarball } = require('./scan-version');

const REPO_ROOT = path.join(__dirname, '..');
const INDEX_PATH = path.join(REPO_ROOT, 'index.json');

function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) return null;
  return { version: `${m[1]}.${m[2]}.${m[3]}`, parts: [+m[1], +m[2], +m[3]] };
}

function compareVersionsDesc(a, b) {
  const pa = parseVersion(a.version).parts, pb = parseVersion(b.version).parts;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
}

function loadExistingIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  } catch {
    return { schema: 1, extensions: [] };
  }
}

async function processListing(listing, prior, blocklist) {
  // Deep-copy the prior entry: it lives inside `existing`, and mutating it in
  // place would make the end-of-run "did anything change?" diff compare the
  // already-mutated existing against the new index — so newly accepted
  // versions of an already-listed extension would never get written.
  const entry = prior
    ? JSON.parse(JSON.stringify(prior))
    : {
        id: listing.id,
        owner: listing.owner,
        name: listing.name,
        repo: listing.repo,
        versions: [],
        rejected: [],
      };
  entry.repo = listing.repo;

  const repoInfo = await ghApi(`/repos/${listing.repo}`);
  if (!repoInfo) {
    console.error(`[index] ${listing.id}: repo ${listing.repo} not found — keeping prior state`);
    return entry;
  }
  if (repoInfo.owner.login.toLowerCase() !== listing.owner.toLowerCase()) {
    console.error(`[index] ${listing.id}: repo owner ${repoInfo.owner.login} != listing owner — skipping`);
    return entry;
  }
  entry.repoUrl = repoInfo.html_url;
  entry.stars = repoInfo.stargazers_count;

  const releases = (await ghApi(`/repos/${listing.repo}/releases?per_page=100`)) || [];
  const known = new Set([
    ...entry.versions.map((v) => v.version),
    ...entry.rejected.map((r) => r.version),
  ]);

  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const parsed = parseVersion(release.tag_name);
    if (!parsed || known.has(parsed.version)) continue;

    const assets = (release.assets || []).filter((a) => /\.(tgz|tar\.gz)$/.test(a.name));
    if (assets.length !== 1) {
      entry.rejected.push({
        version: parsed.version,
        reason: `release must carry exactly one .tgz/.tar.gz asset (found ${assets.length})`,
        at: new Date().toISOString(),
      });
      continue;
    }
    const asset = assets[0];
    console.error(`[index] scanning ${listing.id}@${parsed.version} (${asset.name})`);
    try {
      // The asset API URL + octet-stream works for public AND private repos
      // (browser_download_url 404s on private without a session).
      const buf = await downloadCapped(asset.url, SCAN_LIMITS.compressedBytes, { accept: 'application/octet-stream' });
      const tmp = path.join(os.tmpdir(), `frontier-${listing.owner}-${listing.name}-${parsed.version}.tgz`);
      fs.writeFileSync(tmp, buf);
      const scan = await scanTarball(tmp);
      fs.unlinkSync(tmp);
      if (!scan.ok) {
        entry.rejected.push({ version: parsed.version, reason: scan.errors.join('; '), at: new Date().toISOString() });
        console.error(`[index]   REJECTED: ${scan.errors.join('; ')}`);
        continue;
      }
      entry.versions.push({
        version: parsed.version,
        tag: release.tag_name,
        tarball: asset.browser_download_url,
        // API endpoint for the same asset — the URL clients must use (with a
        // token + octet-stream accept) while the source repo is private.
        assetApiUrl: asset.url,
        sha256: sha256(buf),
        size: buf.length,
        publishedAt: release.published_at,
        scannedAt: new Date().toISOString(),
        flags: scan.flags,
      });
      // Listing metadata always reflects the most recent accepted version.
      entry.displayName = scan.manifest.displayName;
      entry.description = scan.manifest.description;
      entry.defaultColor = scan.manifest.defaultColor;
      entry.capabilities = scan.capabilities;
      entry.serverCode = scan.serverCode;
      entry.dependencies = scan.dependencies;
      entry.networkHosts = scan.networkHosts;
      console.error(`[index]   accepted (${scan.serverCode ? 'server code' : 'ui-only'}, ${scan.dependencies} deps)`);
    } catch (err) {
      entry.rejected.push({ version: parsed.version, reason: err.message, at: new Date().toISOString() });
      console.error(`[index]   FAILED: ${err.message}`);
    }
  }

  entry.versions.sort(compareVersionsDesc);
  entry.latest = entry.versions[0]?.version;
  return entry;
}

async function main() {
  const listings = loadListings(REPO_ROOT);
  const blocklist = loadBlocklist(REPO_ROOT);
  const blockedIds = new Set(blocklist.extensions.map((e) => (typeof e === 'string' ? e : e.id)));
  const blockedPublishers = new Set(blocklist.publishers.map((p) => (typeof p === 'string' ? p : p.owner)));
  const existing = loadExistingIndex();
  const priorById = new Map(existing.extensions.map((e) => [e.id, e]));

  const extensions = [];
  for (const listing of listings) {
    if (blockedIds.has(listing.id) || blockedPublishers.has(listing.owner)) {
      console.error(`[index] ${listing.id}: blocklisted — excluded from index`);
      continue;
    }
    extensions.push(await processListing(listing, priorById.get(listing.id), blocklist));
  }
  extensions.sort((a, b) => a.id.localeCompare(b.id));

  const index = {
    schema: 1,
    registry: 'frontierengineer/extensions',
    generated: new Date().toISOString(),
    extensions: extensions.filter((e) => e.versions.length > 0 || e.rejected.length > 0),
  };

  // `generated` means "when the content last changed", not "when the scan
  // last ran" — if nothing but the timestamp would change, leave the file
  // untouched so the workflow's commit step sees a clean diff and the repo
  // doesn't accrete a no-op commit every scan interval.
  const stripGenerated = (i) => JSON.stringify({ ...i, generated: undefined });
  if (stripGenerated(existing) === stripGenerated(index)) {
    console.error(`[index] unchanged (${index.extensions.length} extension(s)) — not rewriting index.json`);
    return;
  }
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
  console.error(`[index] wrote ${index.extensions.length} extension(s) to index.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
