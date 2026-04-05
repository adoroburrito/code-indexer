import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, listSymbols, listFiles } from '../../db.js';
import { indexDirectory } from '../../indexer.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let tmpDir: string;

beforeEach(() => {
  db = openDb(':memory:');
  tmpDir = join(tmpdir(), `code-indexer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('indexDirectory', () => {
  it('indexes a TypeScript file and returns correct counts', async () => {
    writeFileSync(join(tmpDir, 'foo.ts'), `
export function greet(name: string): string {
  return 'Hello ' + name;
}
export const VERSION = '1.0';
`.trim());

    const result = await indexDirectory(db, tmpDir, tmpDir);
    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.byLanguage['typescript']).toBe(1);
    expect(result.totalSymbols).toBeGreaterThan(0);
  });

  it('indexes a Kotlin file', async () => {
    writeFileSync(join(tmpDir, 'Foo.kt'), `fun greet(name: String): String { return "Hello $name" }`);
    const result = await indexDirectory(db, tmpDir, tmpDir);
    expect(result.indexed).toBe(1);
    expect(result.byLanguage['kotlin']).toBe(1);
  });

  it('indexes both TypeScript and Kotlin in the same run', async () => {
    writeFileSync(join(tmpDir, 'foo.ts'), `export function foo() {}`);
    writeFileSync(join(tmpDir, 'Bar.kt'), `fun bar() {}`);
    const result = await indexDirectory(db, tmpDir, tmpDir);
    expect(result.indexed).toBe(2);
    expect(result.byLanguage['typescript']).toBe(1);
    expect(result.byLanguage['kotlin']).toBe(1);
  });

  it('skips unchanged files on re-index', async () => {
    writeFileSync(join(tmpDir, 'foo.ts'), `export function foo() {}`);
    const first = await indexDirectory(db, tmpDir, tmpDir);
    expect(first.indexed).toBe(1);
    expect(first.skipped).toBe(0);

    const second = await indexDirectory(db, tmpDir, tmpDir);
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('re-indexes a file after it changes', async () => {
    const filePath = join(tmpDir, 'foo.ts');
    writeFileSync(filePath, `export function foo() {}`);
    await indexDirectory(db, tmpDir, tmpDir);

    writeFileSync(filePath, `export function foo() {} export function bar() {}`);
    const result = await indexDirectory(db, tmpDir, tmpDir);
    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);

    const symbols = listSymbols(db);
    expect(symbols.map(s => s.name)).toContain('bar');
  });

  it('calls onProgress for indexed and skipped files', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), `export function a() {}`);
    writeFileSync(join(tmpDir, 'b.ts'), `export function b() {}`);

    const messages: string[] = [];
    await indexDirectory(db, tmpDir, tmpDir, msg => messages.push(msg));
    expect(messages.filter(m => m.startsWith('indexing:'))).toHaveLength(2);

    const messages2: string[] = [];
    await indexDirectory(db, tmpDir, tmpDir, msg => messages2.push(msg));
    expect(messages2.filter(m => m.startsWith('skipped:'))).toHaveLength(2);
  });

  it('skips node_modules, dist, and .git directories', async () => {
    writeFileSync(join(tmpDir, 'real.ts'), `export function real() {}`);
    for (const skipDir of ['node_modules', 'dist', '.git']) {
      mkdirSync(join(tmpDir, skipDir), { recursive: true });
      writeFileSync(join(tmpDir, skipDir, 'ignored.ts'), `export function ignored() {}`);
    }
    const result = await indexDirectory(db, tmpDir, tmpDir);
    expect(result.indexed).toBe(1);
    const files = listFiles(db);
    expect(files.map(f => f.path)).not.toContain(expect.stringContaining('node_modules'));
  });

  it('returns empty result for directory with no supported files', async () => {
    writeFileSync(join(tmpDir, 'readme.md'), '# Hello');
    writeFileSync(join(tmpDir, 'data.json'), '{}');
    const result = await indexDirectory(db, tmpDir, tmpDir);
    expect(result.indexed).toBe(0);
    expect(result.totalSymbols).toBe(0);
  });

  it('returns empty result for nonexistent directory', async () => {
    const result = await indexDirectory(db, join(tmpDir, 'nonexistent'), tmpDir);
    expect(result.indexed).toBe(0);
  });

  it('uses baseDir to compute relative paths', async () => {
    const subDir = join(tmpDir, 'src');
    mkdirSync(subDir);
    writeFileSync(join(subDir, 'foo.ts'), `export function foo() {}`);

    await indexDirectory(db, tmpDir, tmpDir);
    const files = listFiles(db);
    expect(files[0].path).toBe('src/foo.ts');
  });

  it('skips unreadable files and continues indexing others', async () => {
    writeFileSync(join(tmpDir, 'good.ts'), `export function good() {}`);
    const badPath = join(tmpDir, 'bad.ts');
    writeFileSync(badPath, `export function bad() {}`);
    // Remove read permission so readFileSync throws
    chmodSync(badPath, 0o000);

    let result: Awaited<ReturnType<typeof indexDirectory>>;
    try {
      result = await indexDirectory(db, tmpDir, tmpDir);
      // good.ts indexed, bad.ts skipped (read error)
      expect(result.indexed).toBe(1);
    } finally {
      chmodSync(badPath, 0o644); // restore so cleanup works
    }
  });
});
