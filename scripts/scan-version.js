'use strict';
// Scan one application tarball. Used by build-index.js for every new version
// before it enters the index, and runnable standalone:
//   node scripts/scan-version.js path/to/application.tgz
//
// A version is publishable only when this scan passes. Errors block; flags
// are advisory and shown to users at install time.

const fs = require('fs');
const { SCAN_LIMITS, inspectTarball, scanSource, llmReview } = require('./lib');

async function scanTarball(tarballPath) {
  const errors = [];
  const flags = [];

  const stat = fs.statSync(tarballPath);
  if (stat.size > SCAN_LIMITS.compressedBytes) {
    return { ok: false, errors: [`tarball is ${stat.size} bytes (cap ${SCAN_LIMITS.compressedBytes})`], flags };
  }

  let inspection;
  try {
    inspection = inspectTarball(tarballPath);
  } catch (err) {
    return { ok: false, errors: [err.message], flags };
  }
  const { root, manifest, capabilities, serverCode, dependencies, dependencyNames } = inspection;

  const { secrets, flags: patternFlags } = scanSource(root);
  for (const s of secrets) errors.push(`secret detected in ${s.file} (${s.pattern})`);
  flags.push(...patternFlags);

  if (Array.isArray(manifest.network?.allowedHosts) && manifest.network.allowedHosts.includes('*')) {
    flags.push('declares wildcard network access (*) — can reach any external host');
  }

  const review = await llmReview(root, manifest);
  if (review) {
    if (review.verdict === 'malicious') {
      errors.push(`automated review verdict: malicious — ${review.reasons.join('; ')}`);
    } else if (review.verdict === 'suspicious') {
      flags.push(...review.reasons.map((r) => `review: ${r}`));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    flags,
    manifest: {
      displayName: manifest.displayName,
      description: manifest.description,
      defaultColor: manifest.defaultColor,
    },
    capabilities,
    serverCode,
    dependencies,
    dependencyNames,
    // Declared outbound network access — surfaced in the install trust dialog.
    networkHosts: Array.isArray(manifest.network?.allowedHosts)
      ? manifest.network.allowedHosts.filter((h) => typeof h === 'string')
      : [],
    size: stat.size,
  };
}

module.exports = { scanTarball };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/scan-version.js <tarball>');
    process.exit(2);
  }
  scanTarball(target).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });
}
