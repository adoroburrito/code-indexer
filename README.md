# code-indexer

> Parse TypeScript and Kotlin into a SQLite index. Query symbols, read source snippets, trace references — without reading entire files.

Built for LLM agents and developers who need to navigate large codebases efficiently.

---

## The problem

When an LLM (or a developer) needs to understand a function in a large codebase, the naive approach is to read the whole file. That's expensive — often 2,000–10,000 tokens for context you mostly don't need.

`code-indexer` gives you surgical access: ask for exactly the symbol you need and get back just its source, its location, and who references it.

**Measured on [colinhacks/zod](https://github.com/colinhacks/zod) (389 files):**

| Approach | Median tokens | Recall |
|---|---|---|
| Full file read | 4,847 | 100% |
| grep ±10 lines | 412 | 100% |
| **code-indexer** | **130** | **100%** |

LLM quality test (Claude Haiku, 10 questions): code-indexer scored **3.29/4** vs full-file **3.00/4** — using **82% fewer tokens**. Smaller context, better answers.

---

## Install

Requires Node.js 20.

```bash
git clone https://github.com/adoroburrito/code-indexer
cd code-indexer
npm install && npm run build
npm link   # makes `code-indexer` available globally
```

---

## Quick start

```bash
# Index a project
code-indexer index ./my-project

# What's in the index?
code-indexer stats

# Find a symbol
code-indexer find-symbol UserService

# Read its source
code-indexer context UserService

# Find everything that references it
code-indexer find-refs UserService

# Explore a file
code-indexer list-symbols --file src/services/authService.ts
```

---

## Commands

| Command | What it does |
|---|---|
| `index <dir>` | Index all TS/Kotlin files under `dir` (incremental, SHA-256 hashed) |
| `find-symbol <name>` | Find where a symbol is defined |
| `context <name>` | Extract the full source of a symbol |
| `find-refs <name>` | Find all references to a symbol (AST-based, excludes comments/strings) |
| `list-symbols` | List indexed symbols, filterable by `--file` or `--kind` |
| `list-files` | List all indexed files |
| `stats` | Summary of the index (file count, symbol count, db size) |

Global flags: `--db <path>`, `--json` (NDJSON output), `--llm` (LLM usage guide).

Full command reference → [wiki](../../wiki)

---

## Works great with LLMs

Any agent can self-discover how to use the tool:

```bash
code-indexer --llm   # prints a full usage guide optimized for LLM agents
```

Recommended workflow for navigating an unfamiliar codebase:

```bash
code-indexer stats                                # 1. confirm index is ready
code-indexer list-files | grep "area/of/interest" # 2. find relevant files
code-indexer list-symbols --file src/foo.ts       # 3. enumerate symbols
code-indexer context SomeSymbol                   # 4. read what you need
code-indexer find-refs SomeSymbol                 # 5. trace who uses it
```

---

## Unix-composable output

Data to stdout, errors to stderr, tab-delimited by default, `--json` for NDJSON.

```bash
# blast-radius check before a refactor
code-indexer find-refs UserService | cut -f1 | sort -u

# fuzzy symbol search
code-indexer list-symbols | grep -i "error\|handler"

# pipe into jq
code-indexer list-symbols --kind interface --json | jq '.name'
```

---

## How it works

```
source files → tree-sitter AST → symbol + reference extraction → SQLite
```

- **Symbols**: extracted by AST node type (`function_declaration`, `class_declaration`, etc.)
- **References**: every identifier leaf not part of a definition — comments and strings excluded by construction
- **Incremental**: SHA-256 per file, re-index skips unchanged files
- **Storage**: single SQLite file, 3 tables, 5 indexes, WAL mode

---

## Supported languages

| Language | Extensions |
|---|---|
| TypeScript | `.ts`, `.tsx` |
| Kotlin | `.kt`, `.kts` |

---

## See also

- [Wiki](../../wiki) — full command reference, LLM integration guide, internals, limitations
- [`tree-sitter`](https://tree-sitter.github.io/) — AST parser powering symbol extraction
- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — SQLite bindings
- `code-indexer --llm` — LLM-oriented usage guide (built-in)
- `man code-indexer` — man page
