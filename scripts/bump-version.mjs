#!/usr/bin/env node
/**
 * Bump the semantic version in package.json, web/package.json and the matching
 * entries in package-lock.json, without letting npm rewrite the lockfile.
 *
 * Usage: node scripts/bump-version.mjs <patch|minor|major>
 * Prints the new version.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const bump = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('Usage: bump-version.mjs <patch|minor|major>');
  process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

const root = readJson('package.json');
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(root.version);
if (!match) {
  console.error(`Unsupported version "${root.version}"`);
  process.exit(1);
}
let [major, minor, patch] = match.slice(1).map(Number);
if (bump === 'major') [major, minor, patch] = [major + 1, 0, 0];
else if (bump === 'minor') [minor, patch] = [minor + 1, 0];
else patch += 1;
const next = `${major}.${minor}.${patch}`;

root.version = next;
writeJson('package.json', root);

const web = readJson('web/package.json');
web.version = next;
writeJson('web/package.json', web);

const lock = readJson('package-lock.json');
lock.version = next;
if (lock.packages?.['']) lock.packages[''].version = next;
if (lock.packages?.web) lock.packages.web.version = next;
writeJson('package-lock.json', lock);

console.log(next);
