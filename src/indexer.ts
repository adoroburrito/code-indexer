import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';
import { createHash } from 'crypto';
import type { Database as DB } from 'better-sqlite3';
import { parseSource } from './parser.js';
import { getFileHash, getFileMtimes, updateFileMtime, upsertFile, upsertFileBatch, deleteFile, listFiles, setIndexingPragmas } from './db.js';
import type { FileUpsert } from './db.js';
import { typescriptConfig } from './languages/typescript.js';
import { kotlinConfig } from './languages/kotlin.js';
import { rustConfig } from './languages/rust.js';
import { cConfig } from './languages/c.js';
import type { LanguageConfig } from './languages/types.js';

const DEFAULT_MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
const DEFAULT_MAX_MEMORY_MB = 2048; // 2 GB RSS
const MEMORY_CHECK_INTERVAL = 10; // check every N files
const BATCH_SIZE = 50; // files per SQLite transaction

function getRssMB(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

const SKIP_DIRS = new Set([
  'node_modules', 'build', 'dist', '.git', '.next', '.nuxt',
  'out', 'target', '__pycache__', '.cache', 'coverage', '.turbo',
]);

const EXT_MAP: Record<string, { config: LanguageConfig; module: () => Promise<object> }> = {
  '.ts': { config: typescriptConfig, module: () => import('tree-sitter-typescript').then(m => (m.default as { typescript: object }).typescript) },
  '.tsx': { config: typescriptConfig, module: () => import('tree-sitter-typescript').then(m => (m.default as { tsx: object }).tsx) },
  '.kt': { config: kotlinConfig, module: () => import('tree-sitter-kotlin').then(m => m.default as object) },
  '.kts': { config: kotlinConfig, module: () => import('tree-sitter-kotlin').then(m => m.default as object) },
  '.rs': { config: rustConfig, module: () => import('tree-sitter-rust').then(m => m.default as object) },
  '.c': { config: cConfig, module: () => import('tree-sitter-c').then(m => m.default as object) },
  '.h': { config: cConfig, module: () => import('tree-sitter-c').then(m => m.default as object) },
};

// Cache loaded language modules
const langModuleCache = new Map<string, object>();

async function getLangModule(ext: string): Promise<object> {
  if (!langModuleCache.has(ext)) {
    const mod = await EXT_MAP[ext].module();
    langModuleCache.set(ext, mod);
  }
  return langModuleCache.get(ext)!;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  let rawEntries: import('fs').Dirent[];
  try {
    rawEntries = readdirSync(dir, { withFileTypes: true }) as import('fs').Dirent[];
  } catch {
    return results;
  }
  for (const entry of rawEntries) {
    const entryName = String(entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entryName)) {
        results.push(...walkDir(join(dir, entryName)));
      }
    } else if (entry.isFile()) {
      const ext = extname(entryName);
      if (ext in EXT_MAP) {
        results.push(join(dir, entryName));
      }
    }
  }
  return results;
}

export type FileIndexStatus = 'indexed' | 'skipped' | 'deleted' | 'unsupported';

export interface FileIndexResult {
  status: FileIndexStatus;
  symbols?: number;
  refs?: number;
}

// Index a single file. Reads the file, checks hash, parses if changed.
// Does NOT do the mtime fast-path — that's autoRefresh's job.
export async function indexFile(
  db: DB,
  absPath: string,
  baseDir: string,
  onProgress?: (msg: string) => void
): Promise<FileIndexResult> {
  const ext = extname(absPath);
  const entry = EXT_MAP[ext];
  if (!entry) return { status: 'unsupported' };

  const relPath = relative(baseDir, absPath);

  let content: string;
  let mtime: number;
  try {
    const stat = statSync(absPath);
    mtime = stat.mtimeMs;
    content = readFileSync(absPath, 'utf-8');
  } catch {
    const removed = deleteFile(db, relPath);
    return { status: removed ? 'deleted' : 'unsupported' };
  }

  const hash = sha256(content);
  const existingHash = getFileHash(db, relPath);

  if (existingHash === hash) {
    // Content unchanged — update mtime in place so future auto-refresh skips this file
    updateFileMtime(db, relPath, mtime);
    onProgress?.(`skipped: ${relPath} (unchanged)`);
    return { status: 'skipped' };
  }

  onProgress?.(`indexing: ${relPath}`);

  try {
    const langModule = await getLangModule(ext);
    const { symbols, references } = parseSource(content, entry.config, langModule);
    upsertFile(db, relPath, absPath, entry.config.language, hash, mtime, symbols, references);
    return { status: 'indexed', symbols: symbols.length, refs: references.length };
  } catch (e) {
    process.stderr.write(`warning: failed to parse ${relPath}: ${e}\n`);
    return { status: 'unsupported' };
  }
}

export interface RefreshResult {
  indexed: number;
  skipped: number;
  deleted: number;
  byLanguage: Record<string, number>;
  totalSymbols: number;
  totalRefs: number;
  skippedTooBig: number;
  abortedMemoryLimit: boolean;
}

export interface RefreshOptions {
  maxFileSizeBytes?: number;
  maxMemoryMB?: number;
  onProgress?: (msg: string) => void;
  onStatusUpdate?: (msg: string) => void; // periodic summary line (non-verbose progress)
}

// Walk the directory, using stored mtimes as a fast-path to skip unchanged files.
// Handles new files, changed files, and deleted files automatically.
// This is the core of the auto-refresh system — safe to call before every query.
export async function autoRefresh(
  db: DB,
  baseDir: string,
  onProgressOrOptions?: ((msg: string) => void) | RefreshOptions,
  legacyOptions?: RefreshOptions
): Promise<RefreshResult> {
  // Support both old signature (onProgress callback) and new options object
  let opts: RefreshOptions;
  if (typeof onProgressOrOptions === 'function') {
    opts = { onProgress: onProgressOrOptions, ...legacyOptions };
  } else {
    opts = onProgressOrOptions ?? {};
  }

  const {
    maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES,
    maxMemoryMB = DEFAULT_MAX_MEMORY_MB,
    onProgress,
    onStatusUpdate,
  } = opts;

  const result: RefreshResult = {
    indexed: 0, skipped: 0, deleted: 0,
    byLanguage: {}, totalSymbols: 0, totalRefs: 0,
    skippedTooBig: 0, abortedMemoryLimit: false,
  };

  setIndexingPragmas(db);

  const storedMtimes = getFileMtimes(db); // relPath → mtime, one DB query
  const files = walkDir(baseDir);
  const total = files.length;
  const walkedPaths = new Set<string>();
  let filesProcessed = 0;
  const batch: FileUpsert[] = [];
  const STATUS_INTERVAL = 500;

  function flushBatch(): void {
    if (batch.length === 0) return;
    upsertFileBatch(db, batch);
    batch.length = 0;
  }

  for (const absPath of files) {
    // Periodic memory check + status update
    if (++filesProcessed % MEMORY_CHECK_INTERVAL === 0) {
      const rssMB = getRssMB();
      if (rssMB > maxMemoryMB) {
        flushBatch();
        process.stderr.write(
          `warning: memory limit reached (${Math.round(rssMB)} MB RSS > ${maxMemoryMB} MB limit). ` +
          `Stopping early — ${result.indexed} files indexed so far. Re-run to continue incrementally.\n`
        );
        result.abortedMemoryLimit = true;
        break;
      }
    }
    if (onStatusUpdate && filesProcessed % STATUS_INTERVAL === 0) {
      const pct = total > 0 ? Math.round((filesProcessed / total) * 100) : 0;
      onStatusUpdate(`[${filesProcessed}/${total} files scanned, ${pct}% — ${result.indexed} indexed, ${result.skipped} unchanged, ${Math.round(getRssMB())} MB RSS]`);
    }

    const ext = extname(absPath);
    const entry = EXT_MAP[ext];
    if (!entry) continue;

    const relPath = relative(baseDir, absPath);
    walkedPaths.add(relPath);

    // Fast-path: mtime unchanged → skip without reading the file
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }
    const currentMtime = stat.mtimeMs;

    // File size guard — skip before reading
    if (stat.size > maxFileSizeBytes) {
      onProgress?.(`skipped: ${relPath} (${Math.round(stat.size / 1024)} KB > ${Math.round(maxFileSizeBytes / 1024)} KB limit)`);
      result.skippedTooBig++;
      continue;
    }

    const storedMtime = storedMtimes.get(relPath);
    if (storedMtime !== undefined && storedMtime === currentMtime) {
      onProgress?.(`skipped: ${relPath} (unchanged)`);
      result.skipped++;
      continue;
    }

    // mtime changed or new file → read, hash, re-parse if needed
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      process.stderr.write(`warning: could not read ${relPath}\n`);
      continue;
    }

    const hash = sha256(content);
    const existingHash = getFileHash(db, relPath);

    if (existingHash === hash) {
      // Content unchanged (e.g. touch): just record the new mtime
      updateFileMtime(db, relPath, currentMtime);
      result.skipped++;
      continue;
    }

    onProgress?.(`indexing: ${relPath}`);

    try {
      const langModule = await getLangModule(ext);
      const { symbols, references } = parseSource(content, entry.config, langModule);
      batch.push({ filePath: relPath, absPath, language: entry.config.language, hash, mtime: currentMtime, symbols, references });
      result.indexed++;
      result.byLanguage[entry.config.language] = (result.byLanguage[entry.config.language] ?? 0) + 1;
      result.totalSymbols += symbols.length;
      result.totalRefs += references.length;
      if (batch.length >= BATCH_SIZE) flushBatch();
    } catch (e) {
      process.stderr.write(`warning: failed to parse ${relPath}: ${e}\n`);
    }
  }

  flushBatch();

  // Prune DB rows for files that no longer exist on disk
  // (skip if we aborted early — walked set is incomplete)
  if (!result.abortedMemoryLimit) {
    for (const dbFile of listFiles(db)) {
      if (!walkedPaths.has(dbFile.path)) {
        deleteFile(db, dbFile.path);
        onProgress?.(`pruned: ${dbFile.path} (deleted)`);
        result.deleted++;
      }
    }
  }

  return result;
}

// Backwards-compatible wrapper used by the `index` CLI command.
export interface IndexResult {
  indexed: number;
  skipped: number;
  pruned: number;
  byLanguage: Record<string, number>;
  totalSymbols: number;
  totalRefs: number;
  skippedTooBig: number;
  abortedMemoryLimit: boolean;
}

export async function indexDirectory(
  db: DB,
  dir: string,
  baseDir: string,
  onProgressOrOptions?: ((msg: string) => void) | RefreshOptions,
  legacyOptions?: RefreshOptions
): Promise<IndexResult> {
  const r = await autoRefresh(db, baseDir, onProgressOrOptions, legacyOptions);
  return {
    indexed: r.indexed,
    skipped: r.skipped,
    pruned: r.deleted,
    byLanguage: r.byLanguage,
    totalSymbols: r.totalSymbols,
    totalRefs: r.totalRefs,
    skippedTooBig: r.skippedTooBig,
    abortedMemoryLimit: r.abortedMemoryLimit,
  };
}
