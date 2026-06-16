'use strict';
// Validate a listing PR. Run by the validate-listing workflow with the
// TRUSTED scripts from the base branch; the PR's content is only read as
// data (JSON files in a separate checkout), never executed.
//
// A PR that passes every check is auto-merged by the workflow — no human in
// the loop. Anything this script can't mechanically verify fails the PR with
// a reason the author can fix.
//
//   node scripts/validate-listing.js --pr-dir <checkout> --author <login>

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  ghApi, APPLICATION_NAME_RE, normalizeName, editDistance, loadListings, loadBlocklist,
} = require('./lib');

const REPO_ROOT = path.join(__dirname, '..');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function isPublicOrgMember(org, user) {
  const res = await fetch(`https://api.github.com/orgs/${org}/public_members/${user}`, {
    headers: process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
  });
  return res.status === 204;
}

async function main() {
  const args = process.argv.slice(2);
  const prDir = args[args.indexOf('--pr-dir') + 1];
  const author = args[args.indexOf('--author') + 1];
  if (!prDir || !author) fail('usage: --pr-dir <dir> --author <login>');

  const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', 'origin/main...HEAD'], {
    cwd: prDir, encoding: 'utf-8',
  }).split('\n').filter(Boolean);
  const deleted = execFileSync('git', ['diff', '--name-only', '--diff-filter=D', 'origin/main...HEAD'], {
    cwd: prDir, encoding: 'utf-8',
  }).split('\n').filter(Boolean);

  if (changed.length === 0 && deleted.length === 0) fail('PR changes no files');

  // Auto-merge applies ONLY to listing files. Anything else (scripts,
  // workflows, blocklist, index) needs a human — fail so it stays open.
  const LISTING_RE = /^listings\/([^/]+)\/([^/]+)\.json$/;
  for (const f of [...changed, ...deleted]) {
    if (!LISTING_RE.test(f)) fail(`"${f}" is outside listings/ — this PR requires manual review`);
  }

  // Deleting your own listing is allowed (delisting yourself).
  for (const f of deleted) {
    const [, owner] = LISTING_RE.exec(f);
    if (owner.toLowerCase() !== author.toLowerCase() && !(await isPublicOrgMember(owner, author))) {
      fail(`${f}: only ${owner} can delist their own application`);
    }
  }

  const blocklist = loadBlocklist(REPO_ROOT);
  const blockedIds = new Set(blocklist.applications.map((e) => (typeof e === 'string' ? e : e.id)).map((s) => s.toLowerCase()));
  const blockedPublishers = new Set(blocklist.publishers.map((p) => (typeof p === 'string' ? p : p.owner)).map((s) => s.toLowerCase()));
  const reserved = new Set((blocklist.reserved || []).map((s) => s.toLowerCase()));
  const existing = loadListings(REPO_ROOT);

  for (const f of changed) {
    const [, owner, name] = LISTING_RE.exec(f);
    const id = `${owner}/${name}`;

    if (!APPLICATION_NAME_RE.test(name)) fail(`${id}: name must match ${APPLICATION_NAME_RE}`);
    if (blockedPublishers.has(owner.toLowerCase())) fail(`${id}: publisher "${owner}" is blocklisted`);
    if (blockedIds.has(id.toLowerCase())) fail(`${id}: this id was removed from the registry and is permanently reserved`);
    if (reserved.has(id.toLowerCase()) || reserved.has(name.toLowerCase())) fail(`${id}: name is reserved`);

    // Publisher identity: the namespace IS the GitHub identity. The PR author
    // must be the owner account, or a public member of the owner org.
    if (owner.toLowerCase() !== author.toLowerCase() && !(await isPublicOrgMember(owner, author))) {
      fail(`${id}: PR author "${author}" does not own namespace "${owner}" (must be the account itself or a public org member)`);
    }

    let listing;
    try {
      listing = JSON.parse(fs.readFileSync(path.join(prDir, f), 'utf-8'));
    } catch (err) {
      fail(`${id}: invalid JSON — ${err.message}`);
    }
    if (typeof listing.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(listing.repo)) {
      fail(`${id}: listing must be {"repo": "<owner>/<repo>"}`);
    }
    const extraKeys = Object.keys(listing).filter((k) => k !== 'repo');
    if (extraKeys.length) fail(`${id}: unknown listing keys: ${extraKeys.join(', ')} (metadata comes from the scanned application.json, not the listing)`);

    const repoInfo = await ghApi(`/repos/${listing.repo}`);
    if (!repoInfo) fail(`${id}: repo ${listing.repo} does not exist or is private`);
    if (repoInfo.owner.login.toLowerCase() !== owner.toLowerCase()) {
      fail(`${id}: repo ${listing.repo} is owned by ${repoInfo.owner.login}, not ${owner} — the listing namespace must own the source repo`);
    }

    // Typosquat guard: a NEW name may not be confusably close to any existing
    // application owned by someone else. Same-owner updates are exempt.
    const isNew = !existing.some((e) => e.id === id);
    if (isNew) {
      const norm = normalizeName(name);
      for (const other of existing) {
        if (other.owner.toLowerCase() === owner.toLowerCase()) continue;
        const otherNorm = normalizeName(other.name);
        if (norm === otherNorm || editDistance(norm, otherNorm) <= 1) {
          fail(`${id}: name is confusably similar to existing application ${other.id}`);
        }
      }
    }
    console.error(`OK: ${id} -> ${listing.repo}`);
  }

  console.error('All checks passed.');
}

main().catch((err) => fail(err.message));
