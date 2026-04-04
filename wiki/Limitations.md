# Limitations

## Known limitations

**`find-symbol` is exact match only.**
`Zod` will not find `ZodError`. For fuzzy/prefix discovery, use `list-symbols | grep`.

**TypeScript `namespace Foo {}` declarations are not indexed.**

**`const fn = () => ...` is indexed as `variable`, not `function`.**
The symbol is still found by name — only `--kind function` filtering misses it. This is a known gap; distinguishing arrow-function variables from scalar variables requires deeper AST inspection.

**References have ~10–15% miss rate vs grep for very large files.**
The AST walk is structural — it covers identifier nodes correctly, but very large files with unusual constructs may have gaps.

**Node.js startup adds ~120ms per invocation.**
For high-frequency use (e.g. an agent calling many commands in a loop), this adds up. A `serve` command with a persistent process would eliminate this overhead.

---

## Possible next steps

- Prefix/fuzzy search on `find-symbol`
- `serve` command for persistent process (eliminate startup overhead)
- Distinguish `const fn = () => ...` (function) from `const x = 42` (scalar)
- Kotlin codebase validation on a large real-world project
