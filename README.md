# code-indexer

**Parse TypeScript and Kotlin source files into a SQLite database. Query symbols, references, and source snippets from the command line — without reading entire files.**

Built for token-efficient LLM code navigation and Unix-style developer tooling.

---

## Why

When an LLM (or a developer) needs to understand a specific function in a large codebase, the naive approach is to read the whole file. That's expensive — often 2,000–10,000 tokens for context you mostly don't need.

`code-indexer` gives you surgical access: ask for exactly the symbol you need and get back just its source, its location, and who references it.

**Measured on [colinhacks/zod](https://github.com/colinhacks/zod) (389 files):**

| Approach | Median tokens | Recall |
|---|---|---|
| Full file | 4,847 | 100% |
| grep ±10 lines | 412 | 100% |
| **code-indexer** | **130** | **100%** |

LLM quality test (Claude Haiku, 10 questions): indexer scored **3.29/4** vs full-file **3.00/4**, using **82% fewer tokens**. Smaller context, better focus.

---

## Install

Requires Node.js 20.

```bash
git clone https://github.com/your-username/code-indexer
cd code-indexer
npm install
npm run build
npm link        # makes `code-indexer` available globally
```

---

## Quick start

```bash
# Index a project
code-indexer index ./my-project

# Find where a symbol is defined
code-indexer find-symbol UserService

# Read its source
code-indexer context UserService

# Find everything that references it
code-indexer find-refs UserService

# Explore an unfamiliar file
code-indexer list-symbols --file src/services/authService.ts

# Check index stats
code-indexer stats
```

---

## Commands

### `index <dir>`

Recursively index all TypeScript (`.ts`, `.tsx`) and Kotlin (`.kt`, `.kts`) files under `dir`. Uses SHA-256 hashing — re-running only re-indexes changed files.

```
code-indexer index ./my-project
code-indexer index ./my-project --db ./my-project.db
```

Progress goes to stderr. Nothing goes to stdout.

---

### `find-symbol <name>`

Find where a symbol is defined. Exact name match.

```
code-indexer find-symbol UserService
code-indexer find-symbol UserService --kind class
code-indexer find-symbol parse --lang typescript
```

Output: `kind TAB name TAB path TAB startLine-endLine`

Supported `--kind` values: `function`, `class`, `interface`, `method`, `variable`, `type`, `enum`

---

### `context <name>`

Extract the full source of a symbol by reading the original file.

```
code-indexer context UserService
code-indexer context UserService --kind class --lang kotlin
code-indexer context UserService --json
```

Default output:
```
# src/services/userService.ts:12-45
export class UserService {
  ...
}
```

---

### `find-refs <name>`

Find all references to an identifier (every occurrence that is not its own definition). AST-based — excludes comments and string literals.

```
code-indexer find-refs UserService
code-indexer find-refs UserService --lang typescript
code-indexer find-refs parseUser | cut -f1 | sort -u   # files that use it
```

Output: `path TAB line TAB column`

---

### `list-symbols`

List symbols in the index. Indexes only module-level and class-level declarations — local variables inside function bodies are excluded.

```
code-indexer list-symbols --file src/services/authService.ts
code-indexer list-symbols --kind interface
code-indexer list-symbols | grep -i "error\|issue"   # fuzzy search
```

Output: `kind TAB name TAB path TAB startLine-endLine`

> **Warning:** Without `--file` or `--kind`, this returns thousands of lines on large repos. Always filter.

---

### `list-files`

List all indexed files.

```
code-indexer list-files
code-indexer list-files --lang kotlin
code-indexer list-files | grep "src/auth"
```

Output: `language TAB path`

---

### `stats`

Show a summary of the indexed database.

```
code-indexer stats
```

```
files:      389 (389 typescript)
symbols:    3831 (61 classes, 28 enums, 584 functions, 635 interfaces, ...)
references: 117756
db size:    6.3 MB
last indexed: 2026-04-04 19:22:06
```

---

## Global options

| Flag | Description |
|---|---|
| `--db <path>` | Path to the SQLite database. Default: `./code-indexer.db` |
| `--json` | Output as NDJSON (one JSON object per line, not an array) |
| `--help` | Print usage summary |
| `--llm` | Print the extended LLM usage guide to stdout. Works as `code-indexer --llm` or `code-indexer help --llm`. |

---

## Supported languages

| Language | Extensions | Indexed kinds |
|---|---|---|
| TypeScript | `.ts`, `.tsx` | function, class, interface, method, type, enum, variable¹ |
| Kotlin | `.kt`, `.kts` | function, class, object, property² |

¹ `variable` = module-level and class-level `const`/`let` only. Local variables inside functions are not indexed.  
² `property` = file-level and class/object-level declarations only.

---

## Output conventions

- Data always goes to **stdout**
- Progress, warnings, and errors always go to **stderr**
- Default format is tab-delimited text, one record per line
- `--json` switches to NDJSON (newline-delimited JSON — each line is a valid standalone JSON object, not an array)
- Exit code `0` on success (including empty results), `1` on error

This makes output composable with standard Unix tools:

```bash
# How many files reference a symbol?
code-indexer find-refs MyClass | cut -f1 | sort -u | wc -l

# Find all class definitions matching a pattern
code-indexer list-symbols --kind class | grep -i "service\|handler"

# Get all interfaces as JSON for downstream processing
code-indexer list-symbols --kind interface --json | jq '.name'

# Blast-radius check before refactoring
code-indexer find-refs UserService | cut -f1 | sort -u
```

---

## LLM integration

### Self-discovery

Any LLM agent can discover how to use the tool without external documentation:

```bash
code-indexer --llm        # or: code-indexer help --llm
```

This prints a comprehensive usage guide to stdout — covering recommended workflows, token cost estimates, and patterns for navigating unknown codebases.

### Recommended workflow for LLM agents

```
1. code-indexer stats                              # confirm index is ready
2. code-indexer list-files | grep "area/of/interest"  # find relevant files
3. code-indexer list-symbols --file <path>         # enumerate symbols in file
4. code-indexer context <SymbolName>               # read what you need
5. code-indexer find-refs <SymbolName>             # trace who uses it
```

### Token cost estimates (colinhacks/zod, 389 files)

| Command | ~Tokens |
|---|---|
| `stats` | 50 |
| `list-files` | 800 |
| `list-symbols --file X` | 50–500 |
| `list-symbols --kind class` | 400 |
| `find-symbol <name>` | 20–100 |
| `find-refs <name>` | 50–1,000 |
| `context <name>` | 20–500 |

---

## How it works

```
source files
    ↓
tree-sitter AST parser (TypeScript / Kotlin grammar)
    ↓
symbol extraction  +  reference extraction
    ↓
SQLite database (files, symbols, refs tables)
    ↓
CLI queries
```

**Symbols** are extracted from the AST by node type: `function_declaration`, `class_declaration`, `interface_declaration`, etc. Only module-level and class-level `const`/`let` are indexed as `variable` — local variables inside function bodies are excluded.

**References** are every identifier leaf node in the AST that is not the name node of a definition — excluding comments and string literals by construction.

**Incremental indexing**: each file is SHA-256 hashed. Re-running `index` skips unchanged files.

**Storage**: a single SQLite file with three tables (`files`, `symbols`, `refs`) and five indexes. WAL mode. Cascade deletes on re-index.

---

## Development

```bash
npm run build       # compile TypeScript → dist/
npm test            # run test suite (vitest)
npm run test:watch  # watch mode
```

### Man page

```bash
man ./man/code-indexer.1
```

---

## Limitations

- `find-symbol` is **exact match only** — `Zod` will not find `ZodError`. Use `list-symbols | grep` for fuzzy discovery.
- TypeScript `namespace Foo {}` declarations are not indexed.
- `const fn = () => ...` is indexed as `variable`, not `function`. The symbol is still found by name — only `--kind function` filtering misses it.
- References have ~10–15% miss rate vs grep for very large files (AST-structural, not textual).
- Node.js startup adds ~120ms per invocation. For high-frequency use, a persistent server mode would eliminate this.

---

## Status

Work in progress. Core functionality is stable and tested. Validated on a real production codebase ([colinhacks/zod](https://github.com/colinhacks/zod), 389 files).

Possible next steps:
- Prefix/fuzzy search on `find-symbol`
- `serve` command for persistent process (eliminate startup overhead)
- Distinguish `const fn = () => ...` (function) from `const x = 42` (scalar)
- Kotlin codebase validation

---

## See also

- [`tree-sitter`](https://tree-sitter.github.io/) — the AST parser powering symbol extraction
- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — synchronous SQLite bindings for Node.js
- `man code-indexer` — full command reference
- `code-indexer --llm` — LLM-oriented usage guide
