# How It Works

## Pipeline

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

---

## Symbol extraction

Symbols are extracted from the AST by node type:

- `function_declaration` → `function`
- `class_declaration` → `class`
- `interface_declaration` → `interface`
- `lexical_declaration` (module/class-level only) → `variable`
- etc.

Only module-level and class-level declarations are indexed. Local variables inside function bodies are excluded via `parentConstraints` in the language config.

---

## Reference extraction

References are every identifier leaf node in the AST that is **not** the name node of a definition. Comments and string literals are excluded by construction (the AST doesn't include them as identifier nodes).

This means `find-refs` returns real code references only — no false positives from comments like `// See UserService for details`.

---

## Incremental indexing

Each file is SHA-256 hashed before indexing. Re-running `index` on the same directory compares the current hash against the stored one and skips unchanged files.

On re-index of a changed file: the old symbols and references for that file are cascade-deleted and replaced.

---

## Storage

A single SQLite file with three tables:

- `files` — path, language, hash, indexed_at
- `symbols` — name, kind, file_id, start_line, end_line, parent_symbol_id
- `refs` — symbol_name, file_id, line, col

Five indexes cover the common query patterns. WAL mode is enabled for better read concurrency.

---

## Language configs

Each supported language is defined as a `LanguageConfig` object in `src/languages/`:

```typescript
interface LanguageConfig {
  language: string;
  symbolMap: Record<string, string>;     // AST node type → symbol kind
  nameNodeTypes: string[];               // which node types are "name" identifiers
  parentConstraints?: Record<string, string[]>; // allowed parent types per node
}
```

Adding a new language means writing a new config file + loading the corresponding tree-sitter grammar.
