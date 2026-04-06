# code-indexer

Your LLM doesn't need the whole file. It needs the function.

<img src="demo.svg" alt="code-indexer demo" width="100%">

Index a codebase once, then pull any symbol by name and get its source, definition, and callers — without reading a single file.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/adoroburrito/code-indexer/main/install.sh | bash
```

Linux (x64) and macOS (x64 + Apple Silicon). No Node.js required.  
Prefer a direct download? [Releases page](https://github.com/adoroburrito/code-indexer/releases).

---

## Why it exists

When an LLM reads entire files to find one function, most of those tokens are noise. By the time it locates what it needs, it's already burned through a chunk of your context window.

**Measured on [colinhacks/zod](https://github.com/colinhacks/zod) — 389 TypeScript files, 3,831 symbols:**

| Approach | Median tokens | Recall |
|---|---|---|
| Read full file | 7,391 | 100% |
| grep ±10 lines | 188 | 100% |
| **code-indexer** | **40** | **100%** |

99% fewer tokens than reading full files, 79% fewer than grep. Recall is identical.

<details>
<summary>How were these numbers measured?</summary>

**Corpus:** [`colinhacks/zod`](https://github.com/colinhacks/zod) at commit [`c780507`](https://github.com/colinhacks/zod/commit/c7805073fef5b6b8857307c3d4b3597a70613bc2) — 389 TypeScript files, 3,831 module-level symbols.

**Sample:** All module-level symbols (classes, functions, interfaces, types, enums) indexed by `code-indexer`. No cherry-picking; every symbol the tool finds gets measured.

**Token counting:** `Math.ceil(characters / 4)`, a standard approximation within ~5% of cl100k_base and Claude tokenizers for source code. [Verified independently](https://platform.openai.com/tokenizer) on several zod files.

**How each approach retrieves a symbol:**

| Approach | What the LLM actually receives |
|---|---|
| Read full file | The entire `.ts` file containing the symbol (median 7,391 tokens, max 40,082) |
| grep ±10 lines | Lines `[definition_start − 10, definition_end + 10]` (median 188 tokens) |
| code-indexer | `code-indexer context <name>` output (median 40 tokens, max 4,530) |

Recall is 100% for all three because zod uses standard TypeScript declarations with no dynamic exports or runtime symbol generation. code-indexer uses Tree-sitter ASTs rather than regex, so symbol boundaries are correct even for multi-line class bodies and complex generics.

On the worst file in the corpus (40,082 tokens), code-indexer returned 4,530 — 9× less, even in the extreme case.

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

# show just that symbol's source, not the whole file
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

Query commands keep the index fresh on their own. If a file changed since the last run, it gets re-indexed before the query answers. You don't need to re-run `index` manually.

---

## Commands

| Command | What it does |
|---|---|
| `index <dir>` | Build or update the index (incremental, SHA-256 per file) |
| `find-symbol <name>` | Where is this defined? |
| `context <name>` | Show the full source of a symbol |
| `find-refs <name>` | Every reference (AST-based, so comments and strings don't count) |
| `list-symbols` | List symbols, filter with `--file` or `--kind` |
| `list-files` | List indexed files |
| `stats` | File count, symbol count, db size |

**Global:** `--db <path>` · `--json` (NDJSON) · `--no-refresh` · `--llm`  
**Index:** `--max-file-size <KB>` (default 512) · `--max-memory <MB>` (default 2048) · `--loop`

Full reference → [wiki](../../wiki)

---

## Works with everything

stdout for data, stderr for errors, tab-delimited by default with `--json` for NDJSON.

```bash
# how many files depend on this?
code-indexer find-refs UserService | cut -f1 | sort -u | wc -l

# fuzzy search (exact-match is a known limitation; grep is right there)
code-indexer list-symbols | grep -i "error\|handler"

# pipe to jq
code-indexer list-symbols --kind interface --json | jq '.name'
```

LLM agents can figure it out without external docs:

```bash
code-indexer --llm  # full usage guide, token cost estimates, navigation patterns
```

---

## How it works

```
source files → Tree-sitter AST → symbol + reference extraction → SQLite
```

- Symbols come from AST node types. No regex, no heuristics.
- References only match identifier leaves outside definitions, so strings and comments can't produce false positives.
- Re-running `index` is safe; unchanged files are skipped via SHA-256.
- Everything lives in one SQLite file: 4 tables, 5 indexes, WAL mode.

---

## Languages

TypeScript (`.ts`, `.tsx`), Kotlin (`.kt`, `.kts`), Rust (`.rs`), C (`.c`, `.h`)

---

## Add your own language

If your language isn't listed, it's not hard to add. Tree-sitter has grammars for [a lot of languages](https://tree-sitter.github.io/tree-sitter/#available-parsers) and the core doesn't need to change.

You need one config object. Here's the TypeScript one:

```ts
export const typescriptConfig: LanguageConfig = {
  language: 'typescript',
  extensions: ['.ts', '.tsx'],
  symbolMap: {
    // tree-sitter node type → kind stored in the index
    function_declaration: 'function',
    class_declaration:    'class',
    interface_declaration: 'interface',
    method_definition:    'method',
    lexical_declaration:  'variable',
    enum_declaration:     'enum',
    type_alias_declaration: 'type',
  },
  // which child node types hold the symbol's name (checked in order)
  nameNodeTypes: ['identifier', 'type_identifier', 'property_identifier'],
  // optional: only index this node type when its AST parent is one of these
  parentConstraints: {
    lexical_declaration: ['program', 'export_statement'],
  },
};
```

**Steps:**

1. `bun add tree-sitter-<yourlang>` to install the grammar
2. Create `src/languages/<yourlang>.ts` with a `LanguageConfig`, mapping AST node types to symbol kinds
3. Register it in `src/indexer.ts` by adding your extensions to `EXT_MAP`
4. Open a PR if it might be useful to others

Step 2 takes the most time. The hard part is figuring out what Tree-sitter calls things in a given language. Fire up the [Tree-sitter playground](https://tree-sitter.github.io/tree-sitter/playground), paste a sample file, and look at the AST. Those node type names go in `symbolMap`.

`parentConstraints` matters when a node type shows up at multiple levels — say, a variable declaration both inside a function and at module scope. Use it to only index the top-level ones.

If you need something fancier (custom name extraction, filtering out specific nodes), check the [`LanguageConfig` interface](src/languages/types.ts) or the [wiki](../../wiki/Development).

---

**Build from source** (requires [Bun](https://bun.sh)):

```bash
git clone https://github.com/adoroburrito/code-indexer
cd code-indexer && bun install && bun run build
```

[Wiki](../../wiki) · `code-indexer --llm` · `man code-indexer`
