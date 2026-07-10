'use strict';
// Build agents/index.json from agents/catalog/: the flat, host-fetched catalog
// of shareable agents (the agent counterpart to the extension index.json).
//
// Unlike the extension index — which polls external repos and scans tarballs —
// an agent IS its file here: plain text, no code, no artifact to fetch or hash.
// So the "build" is: validate every file, stamp its id/author from the path,
// and (best-effort) enrich each with a community vote count.
//
// Ratings without a server or accounts. Each agent has a GitHub issue in this
// repo labelled `agent-rating` whose title is the agent id. A 👍 reaction on
// that issue is one vote; this build sums them into `votes` and links the
// issue as `ratingUrl`. No Frontier login and no server state — a vote lives
// on GitHub under the voter's GitHub identity, exactly like the marketplace's
// per-repo stars. When no rating issue exists yet, `ratingUrl` is a pre-filled
// "open the rating thread" link so the first voter can create it. Vote fetch
// is best-effort: no token / rate limit / offline just omits counts, never
// fails the build.

const fs = require('fs');
const path = require('path');
const { loadCatalog, validateAgent } = require('./agents-lib');

const REPO_ROOT = path.join(__dirname, '..');
const INDEX_PATH = path.join(REPO_ROOT, 'agents', 'index.json');
const REGISTRY = 'frontierengineer/extensions';
const RATING_LABEL = 'agent-rating';

async function ghApi(pathname) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'frontier-agent-catalog' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${pathname}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${pathname}: ${res.status}`);
  return res.json();
}

// Map agent id → { votes, url } from the repo's `agent-rating` issues. One
// paginated pass over open+closed rating issues; each issue's title is the
// agent id it rates. Best-effort — any failure yields an empty map.
async function loadRatings() {
  const ratings = new Map();
  try {
    for (let page = 1; page <= 10; page++) {
      const issues = await ghApi(`/repos/${REGISTRY}/issues?labels=${RATING_LABEL}&state=all&per_page=100&page=${page}`);
      if (!issues || issues.length === 0) break;
      for (const issue of issues) {
        const id = (issue.title || '').trim();
        if (!id.includes('/')) continue; // titles that aren't an agent id
        ratings.set(id, { votes: issue.reactions?.['+1'] || 0, url: issue.html_url });
      }
      if (issues.length < 100) break;
    }
  } catch (err) {
    console.error(`[agents] rating fetch skipped: ${err.message}`);
  }
  return ratings;
}

// A pre-filled "new issue" link so the first voter can open an agent's rating
// thread, correctly labelled and titled, without hand-editing.
function newRatingIssueUrl(id) {
  const title = encodeURIComponent(id);
  const body = encodeURIComponent(
    `Vote for the "${id}" agent by adding a 👍 reaction to this issue.\n\n` +
    'Please keep to one rating issue per agent so the catalog can count votes.',
  );
  return `https://github.com/${REGISTRY}/issues/new?labels=${RATING_LABEL}&title=${title}&body=${body}`;
}

async function main() {
  const catalog = loadCatalog(REPO_ROOT);

  const errors = [];
  for (const { id, def, file } of catalog) {
    for (const e of validateAgent(def, id)) errors.push(`${file}: ${e}`);
  }
  if (errors.length) {
    console.error('[agents] catalog invalid:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exit(1);
  }

  const ratings = await loadRatings();
  const agents = catalog.map(({ id, author, def }) => {
    const rating = ratings.get(id);
    const entry = {
      id,
      name: def.name,
      description: def.description,
      body: def.body,
      tags: def.tags || [],
      author,
      ratingUrl: rating?.url || newRatingIssueUrl(id),
    };
    if (rating) entry.votes = rating.votes;
    return entry;
  });
  // Most-voted first (unvoted agents fall to name order) so the catalog opens
  // on what the community rates highest.
  agents.sort((a, b) => (b.votes || 0) - (a.votes || 0) || a.name.localeCompare(b.name));

  const index = { schema: 1, registry: REGISTRY, generated: new Date().toISOString(), agents };

  // Leave the file untouched if only `generated` would change, so a scheduled
  // rebuild with no content/vote change doesn't accrete a no-op commit
  // (mirrors the extension indexer).
  const strip = (i) => JSON.stringify({ ...i, generated: undefined });
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8')); } catch { /* first build */ }
  if (existing && strip(existing) === strip(index)) {
    console.error(`[agents] unchanged (${agents.length} agent(s)) — not rewriting index.json`);
    return;
  }
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
  console.error(`[agents] wrote ${agents.length} agent(s) to agents/index.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
