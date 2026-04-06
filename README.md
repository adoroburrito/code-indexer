# code-indexer

Your LLM doesn't need the whole file. It needs the function.

<img src="demo.svg" alt="code-indexer demo" width="100%">

Index a codebase once. Query any symbol by name — get its source, its definition, everything that references it. No file reading. No grep. No context waste.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/adoroburrito/code-indexer/main/install.sh | bash
```

Linux (x64) and macOS (x64 + Apple Silicon). No Node.js required.  
Prefer a direct download? [Releases page](https://github.com/adoroburrito/code-indexer/releases).

---

## Why it exists

Reading full files to find a function is the most expensive way to navigate code. By the time an LLM finds what it needs, it's burned through half your context window on irrelevant lines.

**Measured on [colinhacks/zod](https://github.com/colinhacks/zod) — 389 TypeScript files, 3,831 symbols:**

| Approach | Median tokens | Recall |
|---|---|---|
| Read full file | 7,391 | 100% |
| grep ±10 lines | 188 | 100% |
| **code-indexer** | **40** | **100%** |

**99% fewer tokens than reading the full file. 79% fewer than grep. Same recall.**

<details>
<summary>How were these numbers measured?</summary>

**Corpus:** [`colinhacks/zod`](https://github.com/colinhacks/zod) at commit [`c780507`](https://github.com/colinhacks/zod/commit/c7805073fef5b6b8857307c3d4b3597a70613bc2) — 389 TypeScript files, 3,831 module-level symbols.

**Sample:** All module-level symbols (classes, functions, interfaces, types, enums) indexed by `code-indexer`. No manual cherry-picking — every symbol the tool finds gets measured.

**Token counting:** `Math.ceil(characters / 4)` — a standard approximation within ~5% of cl100k_base and Claude tokenizers for source code. [Verified independently](https://platform.openai.com/tokenizer) on several zod files.

**How each approach retrieves a symbol:**

| Approach | What the LLM actually receives |
|---|---|
| Read full file | The entire `.ts` file that contains the symbol — median 7,391 tokens, max 40,082 |
| grep ±10 lines | Lines `[definition_start − 10, definition_end + 10]` — median 188 tokens |
| code-indexer | `code-indexer context <name>` — exact symbol source only — median 40 tokens, max 4,530 |

**Recall** is 100% for all three because zod uses standard TypeScript declarations — no dynamic exports or runtime symbol generation that would defeat static analysis. code-indexer uses Tree-sitter ASTs, not regex, so it correctly identifies symbol boundaries even for multi-line class bodies and complex generics.

Even at worst case (a 40,082-token file), code-indexer returns at most 4,530 tokens — a 9× saving when the file is at its largest.

**Reproduce it yourself:**

```bash
git clone https://github.com/adoroburrito/code-indexer
cd code-indexer
bun install
git clone --depth=1 https://github.com/colinhacks/zod benchmarks/zod-corpus
bun benchmarks/token-comparison.ts
```

</details>

---

## Usage

```bash
# index once (zod's 389 files take under 2s)
code-indexer index ./my-project

# get the source of a symbol — not the whole file it lives in
code-indexer context UserService

# find everything that calls it before you change it
code-indexer find-refs UserService

# where is it defined?
code-indexer find-symbol parseDate

# what's in this file?
code-indexer list-symbols --file src/auth.ts

# sanity check the index
code-indexer stats
```

Query commands auto-refresh — they detect changed files and re-index before answering. No need to re-run `index` between edits.

---

## Commands

| Command | What it does |
|---|---|
| `index <dir>` | Build or update the index (incremental, SHA-256 per file) |
| `find-symbol <name>` | Where is this defined? |
| `context <name>` | Show the full source of a symbol |
| `find-refs <name>` | Every reference (AST-based — comments and strings can't match) |
| `list-symbols` | List symbols — filter with `--file` or `--kind` |
| `list-files` | List indexed files |
| `stats` | File count, symbol count, db size |

**Global:** `--db <path>` · `--json` (NDJSON) · `--no-refresh` · `--llm`  
**Index:** `--max-file-size <KB>` (default 512) · `--max-memory <MB>` (default 2048) · `--loop`

Full reference → [wiki](../../wiki)

---

## Works with everything

Data to stdout. Errors to stderr. Tab-delimited by default. `--json` for NDJSON.

```bash
# how many files depend on this?
code-indexer find-refs UserService | cut -f1 | sort -u | wc -l

# fuzzy search (exact-match is a known limitation; grep is right there)
code-indexer list-symbols | grep -i "error\|handler"

# pipe to jq
code-indexer list-symbols --kind interface --json | jq '.name'
```

LLM agents can bootstrap themselves without any external docs:

```bash
code-indexer --llm  # prints workflow docs, token cost estimates, navigation patterns to stdout
```

---

## How it works

```
source files → Tree-sitter AST → symbol + reference extraction → SQLite
```

- **No regex.** Symbols come from AST node types — no heuristics.
- **No comment noise.** References are identifier leaves outside definitions. Strings and comments can't produce false positives by construction.
- **Incremental.** SHA-256 per file — re-running skips anything unchanged.
- **One file.** Single SQLite db: 4 tables, 5 indexes, WAL mode.

---

## Languages

TypeScript (`.ts`, `.tsx`), Kotlin (`.kt`, `.kts`), Rust (`.rs`), C (`.c`, `.h`)

Anything else Tree-sitter supports can be added with a small config object — no changes to the core. [See the wiki](../../wiki/Development).

---

**Build from source** (requires [Bun](https://bun.sh)):

```bash
git clone https://github.com/adoroburrito/code-indexer
cd code-indexer && bun install && bun run build
```

[Wiki](../../wiki) · `code-indexer --llm` · `man code-indexer`
