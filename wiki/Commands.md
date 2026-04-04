# Commands

## `index <dir>`

Recursively index all TypeScript (`.ts`, `.tsx`) and Kotlin (`.kt`, `.kts`) files under `dir`. Uses SHA-256 hashing — re-running only re-indexes changed files.

```bash
code-indexer index ./my-project
code-indexer index ./my-project --db ./my-project.db
```

Progress goes to stderr. Nothing goes to stdout.

---

## `find-symbol <name>`

Find where a symbol is defined. Exact name match.

```bash
code-indexer find-symbol UserService
code-indexer find-symbol UserService --kind class
code-indexer find-symbol parse --lang typescript
```

Output: `kind TAB name TAB path TAB startLine-endLine`

Supported `--kind` values: `function`, `class`, `interface`, `method`, `variable`, `type`, `enum`

> Tip: for fuzzy/prefix search, use `list-symbols | grep <pattern>`.

---

## `context <name>`

Extract the full source of a symbol by reading the original file.

```bash
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

## `find-refs <name>`

Find all references to an identifier (every occurrence that is not its own definition). AST-based — excludes comments and string literals.

```bash
code-indexer find-refs UserService
code-indexer find-refs UserService --lang typescript
code-indexer find-refs parseUser | cut -f1 | sort -u   # files that use it
```

Output: `path TAB line TAB column`

---

## `list-symbols`

List symbols in the index. Covers module-level and class-level declarations — local variables inside function bodies are excluded.

```bash
code-indexer list-symbols --file src/services/authService.ts
code-indexer list-symbols --kind interface
code-indexer list-symbols | grep -i "error\|issue"
```

Output: `kind TAB name TAB path TAB startLine-endLine`

> **Warning:** Without `--file` or `--kind`, this returns thousands of lines on large repos. Always filter.

---

## `list-files`

List all indexed files.

```bash
code-indexer list-files
code-indexer list-files --lang kotlin
code-indexer list-files | grep "src/auth"
```

Output: `language TAB path`

---

## `stats`

Show a summary of the indexed database.

```bash
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

## Global flags

| Flag | Description |
|---|---|
| `--db <path>` | Path to the SQLite database. Default: `./code-indexer.db` |
| `--json` | Output as NDJSON (one JSON object per line, not an array) |
| `--help` | Print usage summary |
| `--llm` | Print the extended LLM usage guide to stdout |
