/**
 * `class-validator` / `class-transformer` are OPTIONAL peers. This test
 * installs the BUILT packages (core + drizzle/memory/clickhouse adapters) into
 * a throwaway `node_modules` that contains only their required peers, then
 * imports every entry point in a fresh Node process. Any top-level import of
 * an optional peer makes the import crash with ERR_MODULE_NOT_FOUND.
 *
 * Needs `dist/` for each package (CI builds all packages before testing).
 * Locally, missing builds are skipped unless CI is set.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Pkg {
  dir: string;
  name: string;
  entries: string[];
  peers: string[];
}

const PKGS: Pkg[] = [
  {
    dir: 'core',
    name: '@dudousxd/nestjs-filter',
    entries: ['', '/testing', '/aggregate'],
    peers: ['@nestjs/common', '@nestjs/core', 'reflect-metadata', 'rxjs'],
  },
  {
    dir: 'drizzle',
    name: '@dudousxd/nestjs-filter-drizzle',
    entries: [''],
    peers: ['drizzle-orm'],
  },
  { dir: 'memory', name: '@dudousxd/nestjs-filter-memory', entries: [''], peers: [] },
  {
    dir: 'clickhouse',
    name: '@dudousxd/nestjs-filter-clickhouse',
    entries: [''],
    peers: ['@clickhouse/client'],
  },
];

const OPTIONAL = ['class-validator', 'class-transformer'];

const built = PKGS.filter((p) => existsSync(join(packagesDir, p.dir, 'dist')));
const missing = PKGS.filter((p) => !built.includes(p)).map((p) => p.name);
const mustRunAll = Boolean(process.env.CI);

const root = mkdtempSync(join(tmpdir(), 'nestjs-filter-optional-peers-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function linkPeer(fromPkgDir: string, peer: string): void {
  const target = join(root, 'node_modules', peer);
  if (existsSync(target)) return;
  // Walk up node_modules like Node does (some peers don't export package.json).
  let dir = fromPkgDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', peer);
    if (existsSync(join(candidate, 'package.json'))) {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(realpathSync(candidate), target, 'dir');
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`peer ${peer} not installed for ${fromPkgDir}`);
    dir = parent;
  }
}

describe('optional peers (class-validator / class-transformer)', () => {
  it('every built package is present (CI builds all of them)', () => {
    if (mustRunAll) expect(missing).toEqual([]);
  });

  it.skipIf(built.length === 0)(
    'imports core and adapters without class-validator / class-transformer installed',
    () => {
      for (const p of built) {
        const src = join(packagesDir, p.dir);
        const dest = join(root, 'node_modules', p.name);
        mkdirSync(dest, { recursive: true });
        // Copy (not symlink) so module resolution starts inside `root`.
        cpSync(join(src, 'package.json'), join(dest, 'package.json'));
        cpSync(join(src, 'dist'), join(dest, 'dist'), { recursive: true });
        for (const peer of p.peers) linkPeer(src, peer);
      }
      for (const opt of OPTIONAL) expect(existsSync(join(root, 'node_modules', opt))).toBe(false);

      const specifiers = built.flatMap((p) => p.entries.map((e) => `${p.name}${e}`));
      const script = `
        import 'reflect-metadata';
        for (const opt of ${JSON.stringify(OPTIONAL)}) {
          try { await import(opt); throw new Error('optional peer unexpectedly resolvable: ' + opt); }
          catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
        }
        const out = {};
        for (const s of ${JSON.stringify(specifiers)}) out[s] = Object.keys(await import(s)).length;
        const { ColumnFilterDto, FilterRunner } = await import('@dudousxd/nestjs-filter');
        let dtoError = null;
        try { new ColumnFilterDto(); } catch (e) { dtoError = e.message; }
        out.__dtoError = dtoError;
        out.__runner = typeof FilterRunner;
        console.log(JSON.stringify(out));
      `;
      const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '' },
      });
      const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
      for (const s of specifiers) expect(result[s], s).toBeGreaterThan(0);
      expect(result.__runner).toBe('function');
      expect(result.__dtoError).toMatch(/class-validator.*class-transformer/);
    },
  );
});
