'use strict';
// Stand up the community-rating scaffolding in this repo so votes work from day
// one with no manual maintainer step. Two idempotent, best-effort actions:
//   1. create the `agent-rating` label if it's missing, and
//   2. open one rating issue per catalog agent that doesn't have one yet — title
//      = the agent id, labelled `agent-rating` — which is exactly what
//      build-agents-index.js sums 👍 reactions from.
//
// Run by the agents-index workflow with the repo's GITHUB_TOKEN, before the
// index build. Every create is guarded by an existence check and the
// `agents-index` concurrency group serialises runs, so the 6-hourly cron never
// duplicates a label or an issue. Any failure is logged and swallowed: rating
// scaffolding is a nicety, never a reason to fail the index build.
//
//   node scripts/seed-agent-ratings.js

const path = require('path');
const { loadCatalog } = require('./agents-lib');

const REPO = process.env.GITHUB_REPOSITORY || 'frontierengineer/extensions';
const LABEL = 'agent-rating';
const REPO_ROOT = process.env.SEED_REPO_ROOT || path.join(__dirname, '..');

function api(pathname, init) {
  const token = process.env.GITHUB_TOKEN;
  const hasBody = !!(init && init.body);
  return fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'frontier-agent-catalog',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
  });
}

// Create the `agent-rating` label unless it already exists.
async function ensureLabel() {
  const res = await api(`/repos/${REPO}/labels/${encodeURIComponent(LABEL)}`);
  if (res.ok) {
    console.error(`[seed] label "${LABEL}" already exists`);
    return;
  }
  if (res.status !== 404) throw new Error(`label lookup: ${res.status}`);
  const create = await api(`/repos/${REPO}/labels`, {
    method: 'POST',
    body: JSON.stringify({
      name: LABEL,
      color: '2da44e',
      description: 'One 👍 reaction = one vote for the agent named in the issue title.',
    }),
  });
  // 201 = created; 422 = it raced into existence between the lookup and now.
  if (!create.ok && create.status !== 422) throw new Error(`label create: ${create.status}`);
  console.error(`[seed] label "${LABEL}" ${create.ok ? 'created' : 'already present (raced)'}`);
}

// Titles of every existing `agent-rating` issue (open + closed), so we never
// open a second issue for an agent that already has one.
async function existingRatingTitles() {
  const titles = new Set();
  for (let page = 1; page <= 20; page++) {
    const res = await api(`/repos/${REPO}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
    if (!res.ok) throw new Error(`issue list: ${res.status}`);
    const issues = await res.json();
    if (!Array.isArray(issues) || issues.length === 0) break;
    for (const i of issues) {
      if (i.pull_request) continue; // /issues also returns PRs
      const t = (i.title || '').trim();
      if (t) titles.add(t);
    }
    if (issues.length < 100) break;
  }
  return titles;
}

function issueBody(id) {
  return `Vote for the "${id}" agent by adding a 👍 reaction to this issue.\n\n` +
    'Please keep to one rating issue per agent so the catalog can count votes.';
}

// Open a rating issue for every catalog agent that lacks one. Capped per run as
// a guardrail; the remainder is picked up on the next scheduled run.
async function seedIssues() {
  const catalog = loadCatalog(REPO_ROOT);
  const have = await existingRatingTitles();
  const missing = catalog.map((c) => c.id).filter((id) => !have.has(id));
  if (missing.length === 0) {
    console.error('[seed] every catalog agent already has a rating issue');
    return;
  }
  const cap = Number(process.env.SEED_MAX_NEW_ISSUES || 50);
  const toCreate = missing.slice(0, cap);
  if (missing.length > toCreate.length) {
    console.error(`[seed] ${missing.length} agents need a rating issue; creating ${toCreate.length} this run (cap ${cap}), the rest next run`);
  }
  for (const id of toCreate) {
    const res = await api(`/repos/${REPO}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: id, body: issueBody(id), labels: [LABEL] }),
    });
    if (!res.ok) {
      console.error(`[seed] issue for ${id} failed: ${res.status} (best-effort, will retry next run)`);
      continue;
    }
    console.error(`[seed] opened rating issue for ${id}`);
  }
}

async function main() {
  if (!process.env.GITHUB_TOKEN) {
    console.error('[seed] no GITHUB_TOKEN — skipping (best-effort)');
    return;
  }
  await ensureLabel();
  if (process.env.SEED_RATING_ISSUES !== '0') await seedIssues();
}

// Best-effort: a failure here must never fail the index build.
if (require.main === module) {
  main().catch((err) => { console.error(`[seed] skipped: ${err.message}`); });
}

module.exports = { ensureLabel, existingRatingTitles, seedIssues, main, LABEL };
