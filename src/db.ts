import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { statSync } from 'fs';
import type { ExtractedSymbol, ExtractedReference } from './languages/types.js';

export function openDb(dbPath: string): DB {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      abs_path TEXT NOT NULL,
      language TEXT NOT NULL,
      hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      symbol_name TEXT NOT NULL,
      line INTEGER NOT NULL,
      col INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
    CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(symbol_name);
    CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
  `);
}

export function getFileHash(db: DB, filePath: string): string | null {
  const row = db.prepare('SELECT hash FROM files WHERE path = ?').get(filePath) as { hash: string } | undefined;
  return row ? row.hash : null;
}

export function upsertFile(
  db: DB,
  filePath: string,
  absPath: string,
  language: string,
  hash: string,
  symbols: ExtractedSymbol[],
  references: ExtractedReference[]
): void {
  const upsert = db.transaction(() => {
    db.prepare('DELETE FROM files WHERE path = ?').run(filePath);

    const fileResult = db.prepare(
      "INSERT INTO files (path, abs_path, language, hash, indexed_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(filePath, absPath, language, hash);
    const fileId = fileResult.lastInsertRowid;

    const insertSymbol = db.prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line, parent_symbol_id) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const insertRef = db.prepare(
      'INSERT INTO refs (file_id, symbol_name, line, col) VALUES (?, ?, ?, ?)'
    );

    const localIdMap = new Map<number, bigint>();
    for (let i = 0; i < symbols.length; i++) {
      const s = symbols[i];
      const parentDbId = s.parentSymbolId != null ? (localIdMap.get(s.parentSymbolId) ?? null) : null;
      const result = insertSymbol.run(fileId, s.name, s.kind, s.startLine, s.endLine, parentDbId);
      localIdMap.set(i, result.lastInsertRowid as bigint);
    }

    for (const r of references) {
      insertRef.run(fileId, r.symbolName, r.line, r.column);
    }
  });

  upsert();
}

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  path: string;
  abs_path: string;
  language: string;
}

export interface RefRow {
  path: string;
  line: number;
  col: number;
}

export interface FileRow {
  id: number;
  path: string;
  language: string;
  hash: string;
  indexed_at: string;
}

export function querySymbols(
  db: DB,
  name: string,
  kind?: string,
  lang?: string
): SymbolRow[] {
  let sql = `
    SELECT s.id, s.file_id, s.name, s.kind, s.start_line, s.end_line, f.path, f.abs_path, f.language
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.name = ?
  `;
  const params: unknown[] = [name];
  if (kind) { sql += ' AND s.kind = ?'; params.push(kind); }
  if (lang) { sql += ' AND f.language = ?'; params.push(lang); }
  return db.prepare(sql).all(...params) as SymbolRow[];
}

export function queryRefs(db: DB, name: string, lang?: string): RefRow[] {
  let sql = `
    SELECT f.path, r.line, r.col
    FROM refs r JOIN files f ON f.id = r.file_id
    WHERE r.symbol_name = ?
  `;
  const params: unknown[] = [name];
  if (lang) { sql += ' AND f.language = ?'; params.push(lang); }
  sql += ' ORDER BY f.path, r.line, r.col';
  return db.prepare(sql).all(...params) as RefRow[];
}

export function listFiles(db: DB, lang?: string): FileRow[] {
  let sql = 'SELECT id, path, language, hash, indexed_at FROM files';
  const params: unknown[] = [];
  if (lang) { sql += ' WHERE language = ?'; params.push(lang); }
  sql += ' ORDER BY path';
  return db.prepare(sql).all(...params) as FileRow[];
}

export function listSymbols(db: DB, file?: string, kind?: string): SymbolRow[] {
  let sql = `
    SELECT s.id, s.file_id, s.name, s.kind, s.start_line, s.end_line, f.path, f.abs_path, f.language
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (file) { sql += ' AND f.path = ?'; params.push(file); }
  if (kind) { sql += ' AND s.kind = ?'; params.push(kind); }
  sql += ' ORDER BY f.path, s.start_line';
  return db.prepare(sql).all(...params) as SymbolRow[];
}

export interface StatsResult {
  fileCount: number;
  byLanguage: Record<string, number>;
  symbolCount: number;
  byKind: Record<string, number>;
  refCount: number;
  dbSize: number;
  lastIndexed: string | null;
}

export function getStats(db: DB, dbPath: string): StatsResult {
  const files = db.prepare('SELECT language, COUNT(*) as cnt FROM files GROUP BY language').all() as { language: string; cnt: number }[];
  const kinds = db.prepare('SELECT kind, COUNT(*) as cnt FROM symbols GROUP BY kind').all() as { kind: string; cnt: number }[];
  const refCount = (db.prepare('SELECT COUNT(*) as cnt FROM refs').get() as { cnt: number }).cnt;
  const lastIndexed = (db.prepare('SELECT MAX(indexed_at) as ts FROM files').get() as { ts: string | null }).ts;

  const byLanguage: Record<string, number> = {};
  let fileCount = 0;
  for (const row of files) { byLanguage[row.language] = row.cnt; fileCount += row.cnt; }

  const byKind: Record<string, number> = {};
  let symbolCount = 0;
  for (const row of kinds) { byKind[row.kind] = row.cnt; symbolCount += row.cnt; }

  let dbSize = 0;
  try { dbSize = statSync(dbPath).size; } catch { /* ignore */ }

  return { fileCount, byLanguage, symbolCount, byKind, refCount, dbSize, lastIndexed };
}

export function getSymbolContext(db: DB, symbolName: string): { definitions: SymbolRow[]; references: RefRow[] } {
  const definitions = db.prepare(`
    SELECT s.id, s.file_id, s.name, s.kind, s.start_line, s.end_line, f.path, f.abs_path, f.language
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.name = ?
  `).all(symbolName) as SymbolRow[];

  const references = db.prepare(`
    SELECT f.path, r.line, r.col
    FROM refs r JOIN files f ON f.id = r.file_id
    WHERE r.symbol_name = ?
    ORDER BY f.path, r.line
  `).all(symbolName) as RefRow[];

  return { definitions, references };
}

export function findFilesThatReference(db: DB, symbolName: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT f.path FROM refs r
    JOIN files f ON f.id = r.file_id
    WHERE r.symbol_name = ?
    ORDER BY f.path
  `).all(symbolName) as { path: string }[];
  return rows.map(r => r.path);
}
