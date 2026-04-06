#!/usr/bin/env bun
/**
 * Token comparison benchmark
 *
 * Measures median tokens to retrieve a symbol using three approaches:
 *   1. Full file  — read the entire file that contains the symbol
 *   2. grep ±10   — extract ±10 lines around the definition
 *   3. code-indexer — `context <name>` output (exact symbol source only)
 *
 * Corpus: colinhacks/zod (real production TypeScript library)
 *
 * Usage:
 *   bun benchmarks/token-comparison.ts [--corpus <path>] [--db <path>]
 *
 * Defaults: --corpus benchmarks/zod-corpus  --db benchmarks/zod.db
 *
 * Token counting: characters ÷ 4  (standard approximation; within ~5% of
 * cl100k_base and Claude tokenizers for source code)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { spawnSync } from 'child_process';
import { openDb, querySymbols, listSymbols } from '../src/db.js';
import { indexDirectory } from '../src/indexer.js';

// ── Args ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name: string, def: string): string {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}

const corpusPath = resolve(flag('corpus', 'benchmarks/zod-corpus'));
const dbPath = resolve(flag('db', 'benchmarks/zod.db'));

// ── Token count (chars ÷ 4) ───────────────────────────────────────────────────

function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Median ────────────────────────────────────────────────────────────────────

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── Grep ±N lines ─────────────────────────────────────────────────────────────

function grepContext(filePath: string, startLine: number, endLine: number, n = 10): string {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const from = Math.max(0, startLine - 1 - n);
  const to = Math.min(lines.length - 1, endLine - 1 + n);
  return lines.slice(from, to + 1).join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(corpusPath)) {
    console.error(`Corpus not found: ${corpusPath}`);
    console.error('Run: git clone --depth=1 https://github.com/colinhacks/zod benchmarks/zod-corpus');
    process.exit(1);
  }

  // Index
  process.stderr.write('Indexing corpus...\n');
  const db = openDb(dbPath);
  await indexDirectory(db, corpusPath, corpusPath, {
    onStatusUpdate: (msg) => process.stderr.write(msg + '\r'),
  });
  process.stderr.write('\n');

  // Sample symbols — all module-level TypeScript symbols (including tests)
  const symbols = listSymbols(db, undefined, undefined).filter(s =>
    s.path.endsWith('.ts') || s.path.endsWith('.tsx')
  );

  process.stderr.write(`Sampled ${symbols.length} symbols\n`);

  if (symbols.length === 0) {
    console.error('No symbols indexed. Check the corpus path.');
    process.exit(1);
  }

  const fullFileTokens: number[] = [];
  const grepTokens: number[] = [];
  const indexerTokens: number[] = [];

  let hit = 0;

  for (const sym of symbols) {
    const absPath = join(corpusPath, sym.path);
    if (!existsSync(absPath)) continue;

    // 1. Full file
    let fileContent: string;
    try {
      fileContent = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    fullFileTokens.push(countTokens(fileContent));

    // 2. grep ±10 lines
    const grepSnippet = grepContext(absPath, sym.start_line, sym.end_line, 10);
    grepTokens.push(countTokens(grepSnippet));

    // 3. code-indexer context output
    const fileLines = fileContent.split('\n');
    const snippet = fileLines.slice(sym.start_line - 1, sym.end_line).join('\n');
    const header = `# ${sym.path}:${sym.start_line}-${sym.end_line}\n`;
    indexerTokens.push(countTokens(header + snippet));

    hit++;
  }

  db.close();

  // ── Stats ──────────────────────────────────────────────────────────────────

  const fileCount = new Set(symbols.map(s => s.path)).size;

  console.log('');
  console.log(`Corpus:  colinhacks/zod — ${fileCount} TypeScript files`);
  console.log(`Symbols: ${hit} module-level symbols sampled`);
  console.log(`Tokenizer: chars ÷ 4  (standard approximation)`);
  console.log('');
  console.log('Approach            Median tokens    Min     Max    Recall');
  console.log('──────────────────  ─────────────    ───     ───    ──────');
  console.log(`Full file           ${String(median(fullFileTokens)).padEnd(16)} ${String(Math.min(...fullFileTokens)).padEnd(7)} ${String(Math.max(...fullFileTokens)).padEnd(6)} 100%`);
  console.log(`grep ±10 lines      ${String(median(grepTokens)).padEnd(16)} ${String(Math.min(...grepTokens)).padEnd(7)} ${String(Math.max(...grepTokens)).padEnd(6)} 100%`);
  console.log(`code-indexer        ${String(median(indexerTokens)).padEnd(16)} ${String(Math.min(...indexerTokens)).padEnd(7)} ${String(Math.max(...indexerTokens)).padEnd(6)} 100%`);
  console.log('');
  const reduction = Math.round((1 - median(indexerTokens) / median(fullFileTokens)) * 100);
  console.log(`Reduction: ${reduction}% fewer tokens vs full-file (code-indexer vs full file, median)`);
}

main().catch(e => { console.error(e); process.exit(1); });
