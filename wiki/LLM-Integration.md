# LLM Integration

`code-indexer` was designed from the start for LLM agents. Here's how to get the most out of it.

---

## Self-discovery

Any LLM agent can discover how to use the tool without external documentation:

```bash
code-indexer --llm        # or: code-indexer help --llm
```

This prints a comprehensive usage guide to stdout — covering recommended workflows, token cost estimates, and patterns for navigating unknown codebases.

---

## Recommended workflow

```
1. code-indexer stats                               # confirm index is ready
2. code-indexer list-files | grep "area/of/interest" # find relevant files
3. code-indexer list-symbols --file <path>          # enumerate symbols in file
4. code-indexer context <SymbolName>                # read what you need
5. code-indexer find-refs <SymbolName>              # trace who uses it
```

---

## Token cost estimates

Measured on [colinhacks/zod](https://github.com/colinhacks/zod) (389 files, ~117k references):

| Command | ~Tokens |
|---|---|
| `stats` | 50 |
| `list-files` | 800 |
| `list-symbols --file X` | 50–500 |
| `list-symbols --kind class` | 400 |
| `find-symbol <name>` | 20–100 |
| `find-refs <name>` | 50–1,000 |
| `context <name>` | 20–500 |

Compare: reading a full file in zod averages **4,847 tokens**. Using `context` for the same symbol: **130 tokens**.

---

## Why it beats grep for LLMs

- `grep ±10 lines` is cheap but gives raw text with no structure — the LLM still has to infer what the function signature looks like, where it ends, etc.
- `code-indexer context` gives the full symbol body (correctly bounded by the AST), its path, and its line range — structured, unambiguous context.
- `find-refs` is AST-based: it excludes comments and string literals, so you get real call sites only.

---

## Quality benchmark

LLM quality test (Claude Haiku, 10 questions about the zod codebase):

| Approach | Score (out of 4) | Tokens used |
|---|---|---|
| Full file context | 3.00 | ~4,847 median |
| **code-indexer** | **3.29** | **~130 median** |

Smaller, more focused context → better answers.
