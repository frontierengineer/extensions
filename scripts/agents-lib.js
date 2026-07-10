'use strict';
// Shared helpers for the agent-catalog scripts. Plain Node (>=20), zero deps —
// same constraint as the extension scripts (lib.js): they run in GitHub
// Actions with no npm install, keeping the registry's own supply chain empty.
//
// An agent is a portable, plain-text definition (name + description +
// system-prompt body + tags). Unlike an extension there is no tarball, hash,
// or install-time code — so validation here is schema + size + namespace
// ownership, not a source scan.

const fs = require('fs');
const path = require('path');

// author/slug identity, same shape as extension names (GitHub-handle-safe).
const AGENT_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// An agent is text, so the only real risks are runaway size and junk fields.
// Generous but bounded — a body is a system prompt, not a document.
const LIMITS = {
  name: 80,
  description: 400,
  body: 20000,
  tags: 12,
  tagLen: 32,
};

// Namespaces only Frontier maintainers may write (the first-party starter
// agents). A community PR that adds/edits under these is failed and left for
// manual review — the same way the marketplace reserves removed ids. Everyone
// else authors under their own GitHub login, so the namespace IS the GitHub
// identity and ownership is verifiable (the marketplace's trust model).
const RESERVED_NAMESPACES = new Set(['frontier', 'frontierengineer']);

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// Validate one agent definition (the parsed JSON of a catalog file). Returns
// an array of human-readable errors; empty means valid. `id` is derived from
// the file PATH (<author>/<slug>), never from the file body, so the author
// can't claim a namespace they don't own by editing a field.
function validateAgent(def, id) {
  const errors = [];
  const [author, slug] = (id || '').split('/');
  if (!author || !slug) errors.push(`id "${id}" must be <author>/<slug>`);
  else {
    if (!AGENT_NAME_RE.test(author)) errors.push(`author "${author}" must match ${AGENT_NAME_RE}`);
    if (!AGENT_NAME_RE.test(slug)) errors.push(`slug "${slug}" must match ${AGENT_NAME_RE}`);
  }
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    errors.push('must be a JSON object');
    return errors;
  }
  const str = (k, max) => {
    if (typeof def[k] !== 'string' || !def[k].trim()) errors.push(`"${k}" is required and must be a non-empty string`);
    else if (def[k].length > max) errors.push(`"${k}" exceeds ${max} chars`);
  };
  str('name', LIMITS.name);
  str('description', LIMITS.description);
  str('body', LIMITS.body);
  if (def.tags !== undefined) {
    if (!Array.isArray(def.tags)) errors.push('"tags" must be an array of strings');
    else {
      if (def.tags.length > LIMITS.tags) errors.push(`"tags" has more than ${LIMITS.tags} entries`);
      for (const t of def.tags) {
        if (typeof t !== 'string' || !t.trim()) errors.push('each tag must be a non-empty string');
        else if (t.length > LIMITS.tagLen) errors.push(`tag "${t}" exceeds ${LIMITS.tagLen} chars`);
      }
    }
  }
  const allowed = new Set(['name', 'description', 'body', 'tags']);
  for (const k of Object.keys(def)) {
    if (!allowed.has(k)) errors.push(`unknown field "${k}" (allowed: ${[...allowed].join(', ')})`);
  }
  return errors;
}

// Walk agents/catalog/<author>/<slug>.json → { id, author, slug, file, def },
// sorted deterministically so the built index is stable across machines.
function loadCatalog(repoRoot) {
  const dir = path.join(repoRoot, 'agents', 'catalog');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const author of fs.readdirSync(dir).sort()) {
    const authorDir = path.join(dir, author);
    if (!fs.statSync(authorDir).isDirectory()) continue;
    for (const f of fs.readdirSync(authorDir).sort()) {
      if (!f.endsWith('.json')) continue;
      const slug = f.slice(0, -5);
      out.push({
        id: `${author}/${slug}`,
        author,
        slug,
        file: path.join('agents', 'catalog', author, f),
        def: loadJson(path.join(authorDir, f)),
      });
    }
  }
  return out;
}

module.exports = { AGENT_NAME_RE, LIMITS, RESERVED_NAMESPACES, loadJson, validateAgent, loadCatalog };
