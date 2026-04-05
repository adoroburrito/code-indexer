import { Database } from 'bun:sqlite';
import { statSync } from 'fs';
import type { ExtractedSymbol, ExtractedReference } from './languages/types.js';

export function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  initSchema(db);
  return db;
}

// Call this before bulk indexing. Trades durability for speed — safe because
// the index can always be rebuilt from source.
export function setIndexingPragmas(db: Database): void {
  db.exec('PRAGMA synchronous = OFF');
  db.exec('PRAGMA cache_size = -4096');
  db.exec('PRAGMA temp_store = MEMORY');
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      abs_path TEXT NOT NULL,
      language TEXT NOT NULL,
      hash TEXT NOT NULL,
      mtime REAL,
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

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
    CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(symbol_name);
    CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
  `);

  // Migrate existing DBs that lack the mtime column
  try {
    db.exec('ALTER TABLE files ADD COLUMN mtime REAL');
  } catch {
    // Column already exists — ignore
  }
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null;
  return row ? row.value : null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getFileHash(db: Database, filePath: string): string | null {
  const row = db.prepare('SELECT hash FROM files WHERE path = ?').get(filePath) as { hash: string } | null;
  return row ? row.hash : null;
}

export function getFileMtimes(db: Database): Map<string, number> {
  const rows = db.prepare('SELECT path, mtime FROM files WHERE mtime IS NOT NULL').all() as { path: string; mtime: number }[];
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.path, row.mtime);
  return map;
}

export function updateFileMtime(db: Database, filePath: string, mtime: number): void {
  db.prepare('UPDATE files SET mtime = ? WHERE path = ?').run(mtime, filePath);
}

export interface FileUpsert {
  filePath: string;
  absPath: string;
  language: string;
  hash: string;
  mtime: number;
  symbols: ExtractedSymbol[];
  references: ExtractedReference[];
}

// Single-file upsert (used by indexFile, kept for backwards compatibility).
export function upsertFile(
  db: Database,
  filePath: string,
  absPath: string,
  language: string,
  hash: string,
  mtime: number,
  symbols: ExtractedSymbol[],
  references: ExtractedReference[]
): void {
  upsertFileBatch(db, [{ filePath, absPath, language, hash, mtime, symbols, references }]);
}

// Batch upsert: wraps N files in a single transaction.
// Dramatically faster than N individual transactions for large repos.
export function upsertFileBatch(db: Database, files: FileUpsert[]): void {
  if (files.length === 0) return;
  const delStmt   = db.prepare('DELETE FROM files WHERE path = ?');
  const insFile   = db.prepare("INSERT INTO files (path, abs_path, language, hash, mtime, indexed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))");
  const insSymbol = db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line, parent_symbol_id) VALUES (?, ?, ?, ?, ?, ?)');
  const insRef    = db.prepare('INSERT INTO refs (file_id, symbol_name, line, col) VALUES (?, ?, ?, ?)');

  db.transaction(() => {
    for (const f of files) {
      delStmt.run(f.filePath);
      const fileResult = insFile.run(f.filePath, f.absPath, f.language, f.hash, f.mtime);
      const fileId = fileResult.lastInsertRowid;
      const localIdMap = new Map<number, number>();
      for (let i = 0; i < f.symbols.length; i++) {
        const s = f.symbols[i];
        const parentDbId = s.parentSymbolId != null ? (localIdMap.get(s.parentSymbolId) ?? null) : null;
        const r = insSymbol.run(fileId, s.name, s.kind, s.startLine, s.endLine, parentDbId);
        localIdMap.set(i, r.lastInsertRowid as number);
      }
      for (const r of f.references) {
        insRef.run(fileId, r.symbolName, r.line, r.column);
      }
    }
  })();
}

export function deleteFile(db: Database, filePath: string): boolean {
  const result = db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
  return result.changes > 0;
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
  db: Database,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.prepare(sql).all(...(params as any[])) as SymbolRow[];
}

export function queryRefs(db: Database, name: string, lang?: string): RefRow[] {
  let sql = `
    SELECT f.path, r.line, r.col
    FROM refs r JOIN files f ON f.id = r.file_id
    WHERE r.symbol_name = ?
  `;
  const params: unknown[] = [name];
  if (lang) { sql += ' AND f.language = ?'; params.push(lang); }
  sql += ' ORDER BY f.path, r.line, r.col';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.prepare(sql).all(...(params as any[])) as RefRow[];
}

export function listFiles(db: Database, lang?: string): FileRow[] {
  let sql = 'SELECT id, path, language, hash, indexed_at FROM files';
  const params: unknown[] = [];
  if (lang) { sql += ' WHERE language = ?'; params.push(lang); }
  sql += ' ORDER BY path';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.prepare(sql).all(...(params as any[])) as FileRow[];
}

export function listSymbols(db: Database, file?: string, kind?: string): SymbolRow[] {
  let sql = `
    SELECT s.id, s.file_id, s.name, s.kind, s.start_line, s.end_line, f.path, f.abs_path, f.language
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (file) { sql += ' AND f.path = ?'; params.push(file); }
  if (kind) { sql += ' AND s.kind = ?'; params.push(kind); }
  sql += ' ORDER BY f.path, s.start_line';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.prepare(sql).all(...(params as any[])) as SymbolRow[];
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

export function getStats(db: Database, dbPath: string): StatsResult {
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

export function getSymbolContext(db: Database, symbolName: string): { definitions: SymbolRow[]; references: RefRow[] } {
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

export function findFilesThatReference(db: Database, symbolName: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT f.path FROM refs r
    JOIN files f ON f.id = r.file_id
    WHERE r.symbol_name = ?
    ORDER BY f.path
  `).all(symbolName) as { path: string }[];
  return rows.map(r => r.path);
}
