'use strict';
// Shared helpers for the registry scripts. Plain Node (>=20), zero deps —
// these run in GitHub Actions with no npm install step, which keeps the
// registry's own supply chain at zero packages.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const GITHUB_API = 'https://api.github.com';

function ghHeaders() {
  const h = {
    accept: 'application/vnd.github+json',
    'user-agent': 'frontier-extensions-registry',
  };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function ghApi(pathname) {
  const res = await fetch(`${GITHUB_API}${pathname}`, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${pathname}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Download a URL (following redirects) with a hard size cap. Returns a Buffer.
async function downloadCapped(url, maxBytes) {
  const res = await fetch(url, { headers: ghHeaders(), redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url}: ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error(`download exceeds size cap of ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const EXTENSION_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Confusable-aware normalisation for typosquat checks: lowercase, common
// leetspeak substitutions, separators stripped. "he11o-fr0ntier" and
// "hello-frontier" normalise identically.
function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/[013457]/g, (c) => ({ 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't' }[c]))
    .replace(/[^a-z]/g, '');
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return Math.abs(m - n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function loadBlocklist(repoRoot) {
  try {
    return loadJson(path.join(repoRoot, 'blocklist.json'));
  } catch {
    return { schema: 1, extensions: [], publishers: [], reserved: [] };
  }
}

// Every listing in listings/<owner>/<name>.json → { id, owner, name, repo, file }.
function loadListings(repoRoot) {
  const dir = path.join(repoRoot, 'listings');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const owner of fs.readdirSync(dir)) {
    const ownerDir = path.join(dir, owner);
    if (!fs.statSync(ownerDir).isDirectory()) continue;
    for (const f of fs.readdirSync(ownerDir)) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -5);
      const listing = loadJson(path.join(ownerDir, f));
      out.push({ id: `${owner}/${name}`, owner, name, repo: listing.repo, file: path.join('listings', owner, f) });
    }
  }
  return out;
}

const SCAN_LIMITS = {
  compressedBytes: 25 * 1024 * 1024,
  unpackedBytes: 100 * 1024 * 1024,
  fileCount: 5000,
};

// Capability dirs whose presence means the extension ships that surface.
// mcp/hooks/workspace run IN the host process; runtime runs on the worker —
// all four are "server code" for trust purposes. ui runs in the browser.
const CAPABILITY_DIRS = ['ui', 'mcp', 'hooks', 'workspace', 'runtime'];
const SERVER_CAPABILITIES = new Set(['mcp', 'hooks', 'workspace', 'runtime']);

// Safely unpack a tarball into a fresh temp dir and inspect it as a Frontier
// extension. Rejects path traversal, links, oversize archives. Returns
// { dir, root, manifest, capabilities, serverCode, dependencies, fileCount, unpackedBytes }.
function inspectTarball(tarballPath) {
  const listing = execFileSync('tar', ['-tzvf', tarballPath], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  const lines = listing.split('\n').filter(Boolean);
  if (lines.length > SCAN_LIMITS.fileCount) throw new Error(`archive has ${lines.length} entries (cap ${SCAN_LIMITS.fileCount})`);
  let unpackedBytes = 0;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const type = line[0];
    const entryPath = parts.slice(5).join(' ').replace(/^\.\//, '');
    if (type === 'l' || type === 'h') throw new Error(`archive contains a link entry: ${entryPath}`);
    if (entryPath.startsWith('/') || entryPath.split('/').includes('..')) throw new Error(`unsafe path in archive: ${entryPath}`);
    unpackedBytes += parseInt(parts[2], 10) || 0;
  }
  if (unpackedBytes > SCAN_LIMITS.unpackedBytes) throw new Error(`archive unpacks to ${unpackedBytes} bytes (cap ${SCAN_LIMITS.unpackedBytes})`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-scan-'));
  execFileSync('tar', ['-xzf', tarballPath, '-C', dir]);

  // extension.json must be at the archive root, or inside exactly one
  // top-level directory (the layout `tar -czf` of a parent dir produces).
  let root = dir;
  if (!fs.existsSync(path.join(root, 'extension.json'))) {
    const top = fs.readdirSync(dir).filter((e) => fs.statSync(path.join(dir, e)).isDirectory());
    if (top.length === 1 && fs.existsSync(path.join(dir, top[0], 'extension.json'))) {
      root = path.join(dir, top[0]);
    } else {
      throw new Error('extension.json not found at archive root');
    }
  }
  const manifest = loadJson(path.join(root, 'extension.json'));
  if (typeof manifest.displayName !== 'string' || !manifest.displayName.trim()) {
    throw new Error('extension.json must declare a displayName');
  }
  for (const banned of ['node_modules', 'data', '.git']) {
    if (fs.existsSync(path.join(root, banned))) throw new Error(`archive must not contain ${banned}/`);
  }

  const capabilities = {};
  let dependencies = 0;
  const dependencyNames = [];
  for (const cap of CAPABILITY_DIRS) {
    const capDir = path.join(root, cap);
    capabilities[cap] = fs.existsSync(capDir) &&
      fs.readdirSync(capDir).some((f) => /^index\.(tsx?|jsx?)$/.test(f));
    const pkgPath = path.join(capDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const deps = loadJson(pkgPath).dependencies || {};
        dependencies += Object.keys(deps).length;
        dependencyNames.push(...Object.keys(deps));
      } catch { /* unreadable package.json surfaces at install time */ }
    }
  }
  const serverCode = CAPABILITY_DIRS.some((c) => SERVER_CAPABILITIES.has(c) && capabilities[c]);
  return { dir, root, manifest, capabilities, serverCode, dependencies, dependencyNames, fileCount: lines.length, unpackedBytes };
}

const SECRET_PATTERNS = [
  { name: 'github token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: 'github fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{36,}\b/ },
  { name: 'aws access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'anthropic key', re: /\bsk-ant-[A-Za-z0-9-]{20,}\b/ },
  { name: 'openai key', re: /\bsk-[A-Za-z0-9]{40,}\b/ },
  { name: 'slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36,}\b/ },
];

const FLAG_PATTERNS = [
  { name: 'spawns processes (child_process)', re: /\bchild_process\b|\bexecSync\b|\bspawnSync\b/ },
  { name: 'dynamic code execution (eval / new Function)', re: /\beval\s*\(|new\s+Function\s*\(/ },
  { name: 'obfuscation indicators (base64 decode + exec)', re: /from\s*\(\s*[^)]*,\s*['"]base64['"]\s*\)/ },
  { name: 'outbound network calls (fetch / http)', re: /\bfetch\s*\(|\brequire\(['"]https?['"]\)|from\s+['"]node:https?['"]/ },
  { name: 'reads environment variables', re: /\bprocess\.env\b/ },
];

const TEXT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.html', '.sh', '.yml', '.yaml', '.env']);

function* walkTextFiles(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walkTextFiles(p);
    else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield p;
  }
}

// Secrets are a hard failure (they enable account takeover — the Wiz finding);
// flags are advisory and surfaced to the user in the install dialog.
function scanSource(root) {
  const secrets = [];
  const flags = new Set();
  for (const file of walkTextFiles(root)) {
    const rel = path.relative(root, file);
    let text;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(text)) secrets.push({ file: rel, pattern: name });
    }
    for (const { name, re } of FLAG_PATTERNS) {
      if (re.test(text)) flags.add(name);
    }
  }
  return { secrets, flags: [...flags].sort() };
}

// Optional LLM review of the extension source. Returns null when no
// ANTHROPIC_API_KEY is configured (the check is skipped, not failed). Raw
// fetch by design: these scripts run with zero npm dependencies.
async function llmReview(root, manifest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const MAX_SOURCE = 150_000;
  let source = '';
  for (const file of walkTextFiles(root)) {
    const rel = path.relative(root, file);
    const text = fs.readFileSync(file, 'utf-8');
    const chunk = `\n===== ${rel} =====\n${text}`;
    if (source.length + chunk.length > MAX_SOURCE) {
      source += `\n===== ${rel} ===== (omitted, size budget reached)`;
      continue;
    }
    source += chunk;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.REVIEW_MODEL || 'claude-opus-4-8',
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              verdict: { type: 'string', enum: ['clean', 'suspicious', 'malicious'] },
              reasons: { type: 'array', items: { type: 'string' } },
            },
            required: ['verdict', 'reasons'],
            additionalProperties: false,
          },
        },
      },
      messages: [{
        role: 'user',
        content:
          'You are reviewing a community extension submitted to the Frontier extension registry. ' +
          'Extensions run with FULL host access (Node, network, exec) when they ship mcp/hooks/workspace/runtime code, ' +
          'and same-origin browser access for ui code. Look for: data exfiltration, credential theft, remote code ' +
          'loading (eval of fetched payloads), backdoors, crypto miners, install-time attacks, obfuscated payloads, ' +
          'or behavior wildly inconsistent with the stated purpose. Benign use of fetch/exec consistent with the ' +
          'extension\'s purpose is fine — judge intent, not capability. Verdict "malicious" blocks publication; ' +
          '"suspicious" is surfaced to users as a warning; "clean" passes.\n\n' +
          `Manifest: ${JSON.stringify(manifest)}\n\nSource files:\n${source}`,
      }],
    }),
  });
  if (!res.ok) {
    console.error(`[llm-review] API error ${res.status}: ${await res.text()}`);
    return null; // infra failure → skip, never block publication on our own outage
  }
  const body = await res.json();
  const textBlock = (body.content || []).find((b) => b.type === 'text');
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return null;
  }
}

module.exports = {
  ghApi,
  downloadCapped,
  sha256,
  EXTENSION_NAME_RE,
  normalizeName,
  editDistance,
  loadJson,
  loadBlocklist,
  loadListings,
  SCAN_LIMITS,
  inspectTarball,
  scanSource,
  llmReview,
};
