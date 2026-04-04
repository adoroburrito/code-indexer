import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, upsertFile, getFileHash, querySymbols, queryRefs, listFiles, listSymbols, getSymbolContext, findFilesThatReference, getStats } from '../../db.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('DB operations', () => {
  it('inserts and retrieves files, symbols, and references', () => {
    upsertFile(
      db,
      'src/foo.ts',
      '/abs/src/foo.ts',
      'typescript',
      'abc123',
      [{ name: 'Foo', kind: 'class', startLine: 1, endLine: 10, parentSymbolId: null }],
      [{ symbolName: 'Bar', line: 3, column: 5 }]
    );

    const files = listFiles(db);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/foo.ts');
    expect(files[0].language).toBe('typescript');

    const symbols = listSymbols(db);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('Foo');
    expect(symbols[0].kind).toBe('class');

    const refs = queryRefs(db, 'Bar');
    expect(refs).toHaveLength(1);
    expect(refs[0].line).toBe(3);
    expect(refs[0].col).toBe(5);
  });

  it('returns correct hash for indexed file', () => {
    upsertFile(db, 'a.ts', '/abs/a.ts', 'typescript', 'myhash', [], []);
    expect(getFileHash(db, 'a.ts')).toBe('myhash');
    expect(getFileHash(db, 'nonexistent.ts')).toBeNull();
  });

  it('replaces old data when same path reindexed with different hash', () => {
    upsertFile(
      db,
      'a.ts',
      '/abs/a.ts',
      'typescript',
      'hash1',
      [{ name: 'OldClass', kind: 'class', startLine: 1, endLine: 5, parentSymbolId: null }],
      []
    );
    expect(listSymbols(db)).toHaveLength(1);
    expect(listSymbols(db)[0].name).toBe('OldClass');

    upsertFile(
      db,
      'a.ts',
      '/abs/a.ts',
      'typescript',
      'hash2',
      [{ name: 'NewClass', kind: 'class', startLine: 1, endLine: 5, parentSymbolId: null }],
      []
    );
    expect(getFileHash(db, 'a.ts')).toBe('hash2');
    const symbols = listSymbols(db);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('NewClass');
  });

  it('filters symbols by kind', () => {
    upsertFile(db, 'a.ts', '/abs/a.ts', 'typescript', 'h1', [
      { name: 'MyClass', kind: 'class', startLine: 1, endLine: 10, parentSymbolId: null },
      { name: 'myFn', kind: 'function', startLine: 12, endLine: 15, parentSymbolId: null },
    ], []);
    const classes = listSymbols(db, undefined, 'class');
    expect(classes).toHaveLength(1);
    expect(classes[0].name).toBe('MyClass');
  });

  it('filters symbols by file', () => {
    upsertFile(db, 'a.ts', '/abs/a.ts', 'typescript', 'h1', [
      { name: 'A', kind: 'class', startLine: 1, endLine: 5, parentSymbolId: null },
    ], []);
    upsertFile(db, 'b.ts', '/abs/b.ts', 'typescript', 'h2', [
      { name: 'B', kind: 'class', startLine: 1, endLine: 5, parentSymbolId: null },
    ], []);

    const aSymbols = listSymbols(db, 'a.ts');
    expect(aSymbols).toHaveLength(1);
    expect(aSymbols[0].name).toBe('A');
  });

  it('querySymbols filters by language', () => {
    upsertFile(db, 'a.ts', '/a.ts', 'typescript', 'h1', [
      { name: 'Foo', kind: 'class', startLine: 1, endLine: 5, parentSymbolId: null },
    ], []);
    upsertFile(db, 'a.kt', '/a.kt', 'kotlin', 'h2', [
      { name: 'Foo', kind: 'class', startLine: 1, endLine: 5, parentSymbolId: null },
    ], []);

    const tsOnly = querySymbols(db, 'Foo', undefined, 'typescript');
    expect(tsOnly).toHaveLength(1);
    expect(tsOnly[0].language).toBe('typescript');
  });

  it('pre-built queries work against known dataset', () => {
    upsertFile(db, 'a.ts', '/a.ts', 'typescript', 'h1', [
      { name: 'Foo', kind: 'class', startLine: 1, endLine: 10, parentSymbolId: null },
    ], [
      { symbolName: 'Foo', line: 5, column: 1 },
      { symbolName: 'Bar', line: 6, column: 1 },
    ]);
    upsertFile(db, 'b.ts', '/b.ts', 'typescript', 'h2', [], [
      { symbolName: 'Foo', line: 3, column: 5 },
    ]);

    const ctx = getSymbolContext(db, 'Foo');
    expect(ctx.definitions).toHaveLength(1);
    expect(ctx.references.length).toBeGreaterThanOrEqual(2);

    const files = findFilesThatReference(db, 'Foo');
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files).toContain('b.ts');
  });

  it('getStats returns correct summary of the database', () => {
    upsertFile(db, 'a.ts', '/a.ts', 'typescript', 'h1', [
      { name: 'Foo', kind: 'class', startLine: 1, endLine: 5, parentSymbolId: null },
      { name: 'bar', kind: 'function', startLine: 7, endLine: 10, parentSymbolId: null },
    ], [
      { symbolName: 'Foo', line: 3, column: 1 },
    ]);
    upsertFile(db, 'b.kt', '/b.kt', 'kotlin', 'h2', [
      { name: 'MyClass', kind: 'class', startLine: 1, endLine: 8, parentSymbolId: null },
    ], []);

    const stats = getStats(db, ':memory:');
    expect(stats.fileCount).toBe(2);
    expect(stats.byLanguage['typescript']).toBe(1);
    expect(stats.byLanguage['kotlin']).toBe(1);
    expect(stats.symbolCount).toBe(3);
    expect(stats.byKind['class']).toBe(2);
    expect(stats.byKind['function']).toBe(1);
    expect(stats.refCount).toBe(1);
    expect(stats.lastIndexed).not.toBeNull();
    expect(stats.dbSize).toBe(0); // :memory: has no file on disk
  });

  it('getStats returns empty stats for empty database', () => {
    const stats = getStats(db, ':memory:');
    expect(stats.fileCount).toBe(0);
    expect(stats.symbolCount).toBe(0);
    expect(stats.refCount).toBe(0);
    expect(stats.lastIndexed).toBeNull();
  });
});
