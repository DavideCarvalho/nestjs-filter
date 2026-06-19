import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('CLI generate command', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function runCli(args: string, cwd: string): { stdout: string; exitCode: number } {
    const cliPath = join(__dirname, '../../src/cli/generate.ts');
    try {
      const stdout = execSync(`npx tsx ${cliPath} ${args}`, {
        cwd,
        encoding: 'utf-8',
        timeout: 60000,
      });
      return { stdout, exitCode: 0 };
    } catch (err: any) {
      return { stdout: err.stdout || err.stderr || '', exitCode: err.status ?? 1 };
    }
  }

  it('generates a mikro-orm filter file by default', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nestjs-filter-cli-'));
    const result = runCli('generate user', tempDir);
    expect(result.exitCode).toBe(0);

    const outPath = join(tempDir, 'src', 'user.filter.ts');
    expect(existsSync(outPath)).toBe(true);

    const content = readFileSync(outPath, 'utf-8');
    expect(content).toContain("import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm'");
    expect(content).toContain('class UserFilter extends MikroOrmFilter<User>');
    expect(content).toContain('@Filterable({ entity: User })');
  }, 150000);

  it('generates a typeorm filter file with --orm=typeorm', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nestjs-filter-cli-'));
    const result = runCli('generate order --orm=typeorm', tempDir);
    expect(result.exitCode).toBe(0);

    const outPath = join(tempDir, 'src', 'order.filter.ts');
    expect(existsSync(outPath)).toBe(true);

    const content = readFileSync(outPath, 'utf-8');
    expect(content).toContain("import { TypeOrmFilter } from '@dudousxd/nestjs-filter-typeorm'");
    expect(content).toContain('class OrderFilter extends TypeOrmFilter<Order>');
  }, 150000);

  it('exits with error if file already exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nestjs-filter-cli-'));
    // First generation succeeds
    runCli('generate user', tempDir);
    // Second attempt should fail
    const result = runCli('generate user', tempDir);
    expect(result.exitCode).not.toBe(0);
  }, 150000);

  it('shows usage when no arguments provided', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nestjs-filter-cli-'));
    const result = runCli('', tempDir);
    expect(result.exitCode).not.toBe(0);
  }, 150000);

  it('accepts "g" as shorthand for "generate"', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nestjs-filter-cli-'));
    const result = runCli('g product', tempDir);
    expect(result.exitCode).toBe(0);

    const outPath = join(tempDir, 'src', 'product.filter.ts');
    expect(existsSync(outPath)).toBe(true);
  }, 150000);
});
