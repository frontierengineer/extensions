'use strict';
// Remove a listing — the unpublish lever. The listing is the source of truth
// for `index.json`, so deleting listings/<owner>/<name>.json delists the
// extension on the next rebuild. This only edits the listing file; the source
// repo and its releases are untouched. To stop a specific compromised VERSION
// reaching machines, use blocklist.json (the kill switch), not this. See
// PUBLISHING.md → "Unpublishing and republishing".
//
//   node scripts/unpublish.js <owner>/<name>
//   node scripts/unpublish.js <name>            # defaults owner to frontierengineer

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_OWNER = 'frontierengineer';

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) fail('usage: node scripts/unpublish.js <owner>/<name>  (or just <name>)');

const [owner, name] = arg.includes('/') ? arg.split('/') : [DEFAULT_OWNER, arg];
if (!owner || !name) fail(`could not parse "${arg}" into <owner>/<name>`);

const rel = path.join('listings', owner, `${name}.json`);
const file = path.join(REPO_ROOT, rel);
if (!fs.existsSync(file)) fail(`no listing at ${rel} — nothing to unpublish`);

const repo = (() => {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')).repo; } catch { return undefined; }
})();

fs.unlinkSync(file);

console.log(`removed ${rel}`);
console.log(`"${owner}/${name}" will drop out of index.json on the next rebuild.`);
console.log('');
console.log('To restore it, recreate the file with the same contents:');
console.log(`  ${rel}`);
console.log(`  ${JSON.stringify({ repo: repo || `${owner}/<repo>` })}`);
console.log('');
console.log('Then commit and open a PR (the namespace owner or a public org member).');
console.log('Note: this is a whole-extension switch. To pull a single bad VERSION,');
console.log('use blocklist.json (admin-only) — see PUBLISHING.md.');
