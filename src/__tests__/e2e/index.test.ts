import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const BUN = process.execPath;
const CLI = resolve(process.cwd(), 'src/index.ts');
const FIXTURES = resolve(process.cwd(), 'fixtures');

function run(args: string[], dbPath: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(BUN, [CLI, ...args, '--db', dbPath], {
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 0,
  };
}

function runIndex(dir: string, dbPath: string): { stdout: string; stderr: string; exitCode: number } {
  return run(['index', dir], dbPath);
}

describe('E2E: index command', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'code-indexer-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes fixtures and creates DB with correct counts', () => {
    const result = runIndex(FIXTURES, dbPath);
    expect(result.exitCode).toBe(0);
    // Should have indexed at least 4 files
    expect(result.stderr).toMatch(/indexed \d+ files?/);
    expect(result.stderr).toContain('typescript');
    expect(result.stderr).toContain('kotlin');
  });

  it('stdout is empty during index (progress goes to stderr)', () => {
    const result = runIndex(FIXTURES, dbPath);
    expect(result.stdout.trim()).toBe('');
  });

  it('stderr contains indexing progress lines', () => {
    const result2 = runIndex(FIXTURES, dbPath);
    // Second run: files may be skipped but summary is still on stderr
    expect(result2.stderr).toBeTruthy();
  });

  it('find-symbol returns tab-separated lines with 4 fields', () => {
    const result = run(['find-symbol', 'UserService'], dbPath);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const fields = line.split('\t');
      expect(fields).toHaveLength(4);
    }
  });

  it('find-refs returns tab-separated lines with 3 fields', () => {
    const result = run(['find-refs', 'User'], dbPath);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const fields = line.split('\t');
      expect(fields).toHaveLength(3);
    }
  });

  it('find-symbol --json produces valid NDJSON', () => {
    const result = run(['find-symbol', 'UserService', '--json'], dbPath);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('kind');
      expect(parsed).toHaveProperty('name');
      expect(parsed).toHaveProperty('path');
      expect(parsed).toHaveProperty('startLine');
      expect(parsed).toHaveProperty('endLine');
    }
  });

  it('find-refs --json produces valid NDJSON', () => {
    const result = run(['find-refs', 'User', '--json'], dbPath);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('path');
      expect(parsed).toHaveProperty('line');
      expect(parsed).toHaveProperty('column');
    }
  });

  it('find-symbol for known class returns correct output', () => {
    const result = run(['find-symbol', 'UserService'], dbPath);
    expect(result.stdout).toContain('class');
    expect(result.stdout).toContain('UserService');
  });

  it('context for known symbol returns source lines', () => {
    const result = run(['context', 'UserService', '--lang', 'typescript'], dbPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('UserService');
    expect(result.stdout).toContain('class');
    expect(result.stdout).toMatch(/# .+:\d+-\d+/);
  });

  it('find-symbol --lang filters by language', () => {
    const result = run(['find-symbol', 'UserService', '--lang', 'kotlin'], dbPath);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      expect(line).toContain('.kt');
    }
  });

  it('no results exits with 0', () => {
    const result = run(['find-symbol', 'NonExistentSymbolXYZ123'], dbPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('stats outputs file and symbol counts to stdout', () => {
    const result = run(['stats'], dbPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/files:/);
    expect(result.stdout).toMatch(/symbols:/);
    expect(result.stdout).toMatch(/references:/);
    expect(result.stdout).toMatch(/db size:/);
    expect(result.stderr.trim()).toBe('');
  });

  it('stats --json outputs a JSON object', () => {
    const result = run(['stats', '--json'], dbPath);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveProperty('fileCount');
    expect(parsed).toHaveProperty('symbolCount');
    expect(parsed).toHaveProperty('refCount');
  });

  it('list-files outputs language TAB path lines', () => {
    const result = run(['list-files'], dbPath);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const fields = line.split('\t');
      expect(fields).toHaveLength(2);
      expect(['typescript', 'kotlin']).toContain(fields[0]);
    }
  });

  it('list-files --lang filters by language', () => {
    const tsResult = run(['list-files', '--lang', 'typescript'], dbPath);
    const ktResult = run(['list-files', '--lang', 'kotlin'], dbPath);
    expect(tsResult.stdout).not.toContain('.kt');
    expect(ktResult.stdout).not.toContain('.ts');
    expect(ktResult.stdout).toContain('.kt');
  });

  it('list-files --json produces valid NDJSON', () => {
    const result = run(['list-files', '--json'], dbPath);
    expect(result.exitCode).toBe(0);
    for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('language');
      expect(parsed).toHaveProperty('path');
    }
  });

  it('list-symbols --file returns symbols for that file', () => {
    const result = run(['list-symbols', '--file', 'sample-ts/services/userService.ts'], dbPath);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.split('\t')).toHaveLength(4);
    }
  });

  it('list-symbols --kind filters by kind', () => {
    const result = run(['list-symbols', '--kind', 'class'], dbPath);
    expect(result.exitCode).toBe(0);
    for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
      expect(line.startsWith('class\t')).toBe(true);
    }
  });

  it('list-symbols --json produces valid NDJSON', () => {
    const result = run(['list-symbols', '--kind', 'class', '--json'], dbPath);
    expect(result.exitCode).toBe(0);
    for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('kind');
      expect(parsed).toHaveProperty('name');
      expect(parsed).toHaveProperty('path');
    }
  });

  it('context --json includes source field', () => {
    const result = run(['context', 'UserService', '--lang', 'typescript', '--json'], dbPath);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim().split('\n')[0]);
    expect(parsed).toHaveProperty('source');
    expect(parsed).toHaveProperty('startLine');
    expect(parsed.kind).toBe('class');
  });

  it('find-symbol --kind filters correctly', () => {
    const result = run(['find-symbol', 'UserService', '--kind', 'class'], dbPath);
    expect(result.exitCode).toBe(0);
    for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
      expect(line.startsWith('class\t')).toBe(true);
    }
  });

  it('missing argument exits with code 1 and writes to stderr', () => {
    const result = run(['find-symbol'], dbPath);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('error');
    expect(result.stdout.trim()).toBe('');
  });

  it('missing argument for find-refs exits with code 1', () => {
    const result = run(['find-refs'], dbPath);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('error');
  });

  it('missing argument for context exits with code 1', () => {
    const result = run(['context'], dbPath);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('error');
  });

  it('unknown command exits with code 1 and writes to stderr', () => {
    const result = run(['not-a-command'], dbPath);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown command');
  });

  it('--help prints usage to stderr and exits 0', () => {
    const result = run(['--help'], dbPath);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Usage:');
    expect(result.stdout.trim()).toBe('');
  });

  it('help --llm prints LLM guide to stdout and exits 0', () => {
    const r = spawnSync(BUN, [CLI, 'help', '--llm'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('LLM Usage Guide');
    expect(r.stderr.trim()).toBe('');
  });

  it('--llm as standalone flag also prints LLM guide to stdout', () => {
    const r = spawnSync(BUN, [CLI, '--llm'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('LLM Usage Guide');
    expect(r.stderr.trim()).toBe('');
  });

  it('incremental indexing skips unchanged files', () => {
    // First index
    let tmp2 = mkdtempSync(join(tmpdir(), 'ci2-'));
    let db2 = join(tmp2, 'inc.db');
    const fixtureDir = join(tmp2, 'src');
    mkdirSync(fixtureDir);
    writeFileSync(join(fixtureDir, 'a.ts'), 'export interface Foo { id: string; }');
    writeFileSync(join(fixtureDir, 'b.ts'), 'export class Bar { doIt(): void {} }');

    const r1 = runIndex(fixtureDir, db2);
    expect(r1.stderr).toContain('indexing: a.ts');
    expect(r1.stderr).toContain('indexing: b.ts');

    // Modify only b.ts
    writeFileSync(join(fixtureDir, 'b.ts'), 'export class Bar { doItNow(): void {} }');

    const r2 = runIndex(fixtureDir, db2);
    expect(r2.stderr).toContain('skipped: a.ts (unchanged)');
    expect(r2.stderr).toContain('indexing: b.ts');

    rmSync(tmp2, { recursive: true, force: true });
  });
});
