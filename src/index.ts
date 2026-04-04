#!/usr/bin/env node
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { openDb, querySymbols, queryRefs, listFiles, listSymbols, getStats } from './db.js';
import { indexDirectory } from './indexer.js';

// ── Help text ──────────────────────────────────────────────────────────────

const HUMAN_HELP = `
Usage: code-indexer <command> [options]

Commands:
  index <dir>            Index a project directory (TypeScript + Kotlin)
  find-symbol <name>     Find where a symbol is defined (exact name match)
  find-refs <name>       Find all references to an identifier
  context <name>         Extract the source code of a symbol's definition
  stats                  Show index statistics
  list-files             List all indexed files
  list-symbols           List all indexed symbols

Options:
  --db <path>            SQLite database path (default: ./code-indexer.db)
  --json                 Output as newline-delimited JSON (NDJSON)
  --kind <kind>          Filter by symbol kind: function|class|interface|method|variable|type|enum
  --lang <lang>          Filter by language: typescript|kotlin
  --file <path>          Filter by file path (list-symbols only)

Output formats:
  find-symbol   kind<TAB>name<TAB>path<TAB>start-end
  find-refs     path<TAB>line<TAB>column
  list-files    language<TAB>path
  list-symbols  kind<TAB>name<TAB>path<TAB>start-end

Tips:
  Use grep to filter list-symbols output:
    code-indexer list-symbols | grep -i "user"
  Pipe find-refs to count usages:
    code-indexer find-refs MyClass | wc -l
  Get LLM-oriented usage guide:
    code-indexer help --llm
`.trimStart();

const LLM_GUIDE = `
# code-indexer — LLM Usage Guide

code-indexer indexes a source code repository into a SQLite database, enabling
precise symbol lookup without reading entire files. This guide describes how to
use it effectively as an LLM tool.

## Purpose

Retrieve exactly the code context you need — nothing more. Instead of reading
whole files (expensive), query the index for specific symbols (cheap).

## Recommended workflow for exploring an unknown codebase

Step 1: Check what has been indexed
  code-indexer stats
  → Shows file count, symbol count, languages. Confirms the index is ready.

Step 2: Discover files in the area you care about
  code-indexer list-files
  → One line per file: language<TAB>path. Use to orient yourself.
  WARNING: On large repos this can be hundreds of lines. Pipe through grep:
    code-indexer list-files | grep "src/auth"

Step 3: Discover symbols in a specific file
  code-indexer list-symbols --file src/services/userService.ts
  → Lists all module-level symbols: classes, functions, interfaces, types,
    module-level constants. Local variables inside functions are not indexed.
    Low token cost (~10-50 symbols per file).
  WARNING: Do NOT run list-symbols without --file or --kind on large repos.
  It can return thousands of lines (10k+ tokens). Always filter.

Step 3b: Search across all symbols when you don't know which file
  code-indexer list-symbols --kind class | grep -i auth
  code-indexer list-symbols | grep -i "error\|issue"
  → Grep is your fuzzy search. Combine with --kind to narrow scope.

Step 4: Get the source of a specific symbol
  code-indexer context UserService
  → Returns only the source lines of that definition. Typically 20-300 tokens.
  Use --lang to disambiguate if multiple languages define the same name:
    code-indexer context UserService --lang typescript

Step 5: Find where a symbol is used
  code-indexer find-refs UserService
  → Returns file+line+column for every reference. No source code included.
  Token-efficient: 10 refs = ~50 tokens vs grep output = ~500 tokens.

## Command reference

  index <dir>            Build or update the index. Safe to re-run (incremental).

  find-symbol <name>     Exact name match. Returns kind, name, path, line range.
  find-symbol <name> --kind class     Filter to only class definitions.
  find-symbol <name> --lang kotlin    Filter to only Kotlin files.

  find-refs <name>       All references to an identifier (not its definition).
  find-refs <name> --json             NDJSON output for structured processing.

  context <name>         Source code of the symbol. Reads the actual file.
  context <name> --kind function      Disambiguate by kind.
  context <name> --lang typescript    Disambiguate by language.

  list-files             All indexed files. Filter with --lang kotlin.
  list-symbols           All symbols. ALWAYS use --file <path> or --kind <kind>.
  stats                  File/symbol/reference counts + db size.

## Token cost guidelines (measured on colinhacks/zod, 389 files)

  stats                  ~50 tokens
  list-files             ~800 tokens (full repo)
  list-files --lang X    ~400 tokens
  list-symbols --file X  ~50-500 tokens (module-level symbols only)
  list-symbols --kind class  ~400 tokens (full repo)
  list-symbols (no filter)   ~10000 tokens — AVOID on large repos
  find-symbol <name>     ~20-100 tokens
  find-refs <name>       ~50-1000 tokens depending on usage count
  context <name>         ~20-500 tokens (just the symbol body)

## What find-symbol does NOT do

  - Fuzzy or prefix matching: "Zod" will not find "ZodError"
  - TypeScript namespaces (namespace Foo {}) are not indexed
  - If you don't know the exact name, use grep as fuzzy search:
      code-indexer list-symbols | grep -i <keyword>
      code-indexer list-symbols --file <relevant-file>
    then context <name> to read the code.

## Output formats

All query commands output tab-separated text by default:
  find-symbol → kind TAB name TAB path TAB startLine-endLine
  find-refs   → path TAB line TAB column
  list-files  → language TAB path
  list-symbols → kind TAB name TAB path TAB startLine-endLine

Add --json for NDJSON (one JSON object per line, not an array).

Progress and warnings always go to stderr. Data always goes to stdout.
`.trimStart();


function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const [, , command = '', ...rest] = argv;
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(tok);
    }
  }

  return { command, args, flags };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function printSymbol(row: { kind: string; name: string; path: string; start_line: number; end_line: number }, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({
      kind: row.kind,
      name: row.name,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
    }) + '\n');
  } else {
    process.stdout.write(`${row.kind}\t${row.name}\t${row.path}\t${row.start_line}-${row.end_line}\n`);
  }
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv);
  const dbPath = typeof flags['db'] === 'string' ? flags['db'] : './code-indexer.db';
  const useJson = flags['json'] === true;

  if (!command || command === 'help' || command === '--help' || command === '--llm' || flags['help']) {
    const llmMode = command === '--llm' || flags['llm'] === true;
    if (llmMode) {
      process.stdout.write(LLM_GUIDE);
    } else {
      process.stderr.write(HUMAN_HELP);
    }
    process.exit(0);
  }

  if (command === 'index') {
    const dir = args[0];
    if (!dir) {
      process.stderr.write('error: missing <dir> argument\n');
      process.exit(1);
    }
    const absDir = resolve(dir);
    const db = openDb(dbPath);
    const result = await indexDirectory(db, absDir, absDir, (msg) => {
      process.stderr.write(msg + '\n');
    });
    db.close();

    const langSummary = Object.entries(result.byLanguage).map(([l, c]) => `${c} ${l}`).join(', ');
    const skippedNote = result.skipped > 0 ? ` (${result.skipped} skipped)` : '';
    const fileWord = result.indexed === 1 ? 'file' : 'files';
    process.stderr.write(
      `indexed ${result.indexed} ${fileWord}${langSummary ? ` (${langSummary})` : ''} — ${result.totalSymbols} symbols, ${result.totalRefs} references${skippedNote}\n`
    );
    process.exit(0);
  }

  if (command === 'find-symbol') {
    const name = args[0];
    if (!name) { process.stderr.write('error: missing <name>\n'); process.exit(1); }
    const db = openDb(dbPath);
    const kind = typeof flags['kind'] === 'string' ? flags['kind'] : undefined;
    const lang = typeof flags['lang'] === 'string' ? flags['lang'] : undefined;
    const rows = querySymbols(db, name, kind, lang);
    db.close();
    for (const row of rows) printSymbol(row, useJson);
    process.exit(0);
  }

  if (command === 'find-refs') {
    const name = args[0];
    if (!name) { process.stderr.write('error: missing <name>\n'); process.exit(1); }
    const db = openDb(dbPath);
    const lang = typeof flags['lang'] === 'string' ? flags['lang'] : undefined;
    const rows = queryRefs(db, name, lang);
    db.close();
    for (const row of rows) {
      if (useJson) {
        process.stdout.write(JSON.stringify({ path: row.path, line: row.line, column: row.col }) + '\n');
      } else {
        process.stdout.write(`${row.path}\t${row.line}\t${row.col}\n`);
      }
    }
    process.exit(0);
  }

  if (command === 'context') {
    const name = args[0];
    if (!name) { process.stderr.write('error: missing <name>\n'); process.exit(1); }
    const db = openDb(dbPath);
    const lang = typeof flags['lang'] === 'string' ? flags['lang'] : undefined;
    const kind = typeof flags['kind'] === 'string' ? flags['kind'] : undefined;
    const rows = querySymbols(db, name, kind, lang);
    db.close();

    if (rows.length === 0) process.exit(0);

    const seen = new Set<string>();
    let first = true;
    for (const row of rows) {
      const key = `${row.path}:${row.start_line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let fileContent: string;
      try {
        fileContent = readFileSync(row.abs_path, 'utf-8');
      } catch {
        process.stderr.write(`warning: could not read ${row.path}\n`);
        continue;
      }
      const fileLines = fileContent.split('\n');
      const startIdx = row.start_line - 1;
      const endIdx = row.end_line - 1;
      const snippet = fileLines.slice(startIdx, endIdx + 1).join('\n');

      if (useJson) {
        process.stdout.write(JSON.stringify({
          kind: row.kind,
          name: row.name,
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          source: snippet,
        }) + '\n');
      } else {
        if (!first) process.stdout.write('\n');
        process.stdout.write(`# ${row.path}:${row.start_line}-${row.end_line}\n`);
        process.stdout.write(snippet + '\n');
        first = false;
      }
    }
    process.exit(0);
  }

  if (command === 'stats') {
    const db = openDb(dbPath);
    const stats = getStats(db, dbPath);
    db.close();

    const langStr = Object.entries(stats.byLanguage).map(([l, c]) => `${c} ${l}`).join(', ');
    const kindStr = Object.entries(stats.byKind).map(([k, c]) => `${c} ${k === 'class' ? 'classes' : k + 's'}`).join(', ');

    if (useJson) {
      process.stdout.write(JSON.stringify(stats) + '\n');
    } else {
      process.stdout.write(`files:      ${stats.fileCount}${langStr ? ` (${langStr})` : ''}\n`);
      process.stdout.write(`symbols:    ${stats.symbolCount}${kindStr ? ` (${kindStr})` : ''}\n`);
      process.stdout.write(`references: ${stats.refCount}\n`);
      process.stdout.write(`db size:    ${formatSize(stats.dbSize)}\n`);
      process.stdout.write(`last indexed: ${stats.lastIndexed ?? 'never'}\n`);
    }
    process.exit(0);
  }

  if (command === 'list-files') {
    const db = openDb(dbPath);
    const lang = typeof flags['lang'] === 'string' ? flags['lang'] : undefined;
    const rows = listFiles(db, lang);
    db.close();
    for (const row of rows) {
      if (useJson) {
        process.stdout.write(JSON.stringify({ language: row.language, path: row.path, hash: row.hash, indexedAt: row.indexed_at }) + '\n');
      } else {
        process.stdout.write(`${row.language}\t${row.path}\n`);
      }
    }
    process.exit(0);
  }

  if (command === 'list-symbols') {
    const db = openDb(dbPath);
    const file = typeof flags['file'] === 'string' ? flags['file'] : undefined;
    const kind = typeof flags['kind'] === 'string' ? flags['kind'] : undefined;
    const rows = listSymbols(db, file, kind);
    db.close();
    for (const row of rows) printSymbol(row, useJson);
    process.exit(0);
  }

  process.stderr.write(`error: unknown command '${command}'. Run 'code-indexer help' for usage.\n`);
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e}\n`);
  process.exit(1);
});
