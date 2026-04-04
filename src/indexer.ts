import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';
import { createHash } from 'crypto';
import type { Database as DB } from 'better-sqlite3';
import { parseSource } from './parser.js';
import { getFileHash, upsertFile } from './db.js';
import { typescriptConfig } from './languages/typescript.js';
import { kotlinConfig } from './languages/kotlin.js';
import type { LanguageConfig } from './languages/types.js';

const SKIP_DIRS = new Set([
  'node_modules', 'build', 'dist', '.git', '.next', '.nuxt',
  'out', 'target', '__pycache__', '.cache', 'coverage', '.turbo',
]);

const EXT_MAP: Record<string, { config: LanguageConfig; module: () => Promise<object> }> = {
  '.ts': { config: typescriptConfig, module: () => import('tree-sitter-typescript').then(m => (m.default as { typescript: object }).typescript) },
  '.tsx': { config: typescriptConfig, module: () => import('tree-sitter-typescript').then(m => (m.default as { tsx: object }).tsx) },
  '.kt': { config: kotlinConfig, module: () => import('tree-sitter-kotlin').then(m => m.default as object) },
  '.kts': { config: kotlinConfig, module: () => import('tree-sitter-kotlin').then(m => m.default as object) },
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

export interface IndexResult {
  indexed: number;
  skipped: number;
  byLanguage: Record<string, number>;
  totalSymbols: number;
  totalRefs: number;
}

export async function indexDirectory(
  db: DB,
  dir: string,
  baseDir: string,
  onProgress?: (msg: string) => void
): Promise<IndexResult> {
  const files = walkDir(dir);
  const result: IndexResult = { indexed: 0, skipped: 0, byLanguage: {}, totalSymbols: 0, totalRefs: 0 };

  for (const absPath of files) {
    const relPath = relative(baseDir, absPath);
    const ext = extname(absPath);
    const entry = EXT_MAP[ext];
    if (!entry) continue;

    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch (e) {
      process.stderr.write(`warning: could not read ${relPath}: ${e}\n`);
      continue;
    }

    const hash = sha256(content);
    const existingHash = getFileHash(db, relPath);

    if (existingHash === hash) {
      onProgress?.(`skipped: ${relPath} (unchanged)`);
      result.skipped++;
      continue;
    }

    onProgress?.(`indexing: ${relPath}`);

    try {
      const langModule = await getLangModule(ext);
      const { symbols, references } = parseSource(content, entry.config, langModule);
      upsertFile(db, relPath, absPath, entry.config.language, hash, symbols, references);
      result.indexed++;
      result.byLanguage[entry.config.language] = (result.byLanguage[entry.config.language] ?? 0) + 1;
      result.totalSymbols += symbols.length;
      result.totalRefs += references.length;
    } catch (e) {
      process.stderr.write(`warning: failed to parse ${relPath}: ${e}\n`);
    }
  }

  return result;
}
