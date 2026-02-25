#!/usr/bin/env node
/**
 * Stamps a version string into package.json and jsr.json.
 *
 * Usage:
 *   node scripts/set-version.mjs <version>
 *
 * The version may optionally include a leading "v" (e.g. "v0.1.2" or "0.1.2").
 * Both files are written in-place; no git operations are performed.
 */

import { readFileSync, writeFileSync } from 'fs';

const raw = process.argv[2];

if (!raw) {
  console.error('Usage: node scripts/set-version.mjs <version>');
  process.exit(1);
}

const version = raw.replace(/^v/, '');

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Invalid version: "${version}"`);
  process.exit(1);
}

for (const file of ['package.json', 'jsr.json']) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  console.log(`${file}: version set to ${version}`);
}
