/**
 * Keep each package's `VERSION` export in step with the version in its own package.json.
 *
 * `VERSION` is a literal in source, so `changeset version` bumps package.json and leaves the
 * literal behind — tsc then bakes the stale number into dist and consumers read it. Wiring this
 * into `version-packages` closes that gap; `--check` in `release` makes a publish fail rather
 * than ship a number that lies about itself.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = join(import.meta.dirname, '..', 'packages');
const PATTERN = /(export const VERSION = ')([^']*)(')/;
const check = process.argv.includes('--check');

let changed = 0;
const stale = [];

for (const name of readdirSync(PACKAGES)) {
  const indexPath = join(PACKAGES, name, 'src', 'index.ts');

  let version;
  let source;
  try {
    version = JSON.parse(readFileSync(join(PACKAGES, name, 'package.json'), 'utf8')).version;
    source = readFileSync(indexPath, 'utf8');
  } catch {
    continue;
  }

  const match = source.match(PATTERN);
  if (!match) continue;
  if (match[2] === version) continue;

  if (check) {
    stale.push(`${name}: VERSION is '${match[2]}', package.json says '${version}'`);
    continue;
  }

  writeFileSync(indexPath, source.replace(PATTERN, `$1${version}$3`));
  console.log(`sync-version: ${name} → ${version}`);
  changed += 1;
}

if (stale.length > 0) {
  console.error(`sync-version: ${stale.length} package(s) out of sync`);
  for (const line of stale) console.error(`  ${line}`);
  process.exit(1);
}

console.log(
  changed === 0
    ? 'sync-version: every VERSION matches its package.json'
    : `sync-version: updated ${changed}`,
);
