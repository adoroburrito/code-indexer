# Development

## Setup

```bash
git clone https://github.com/adoroburrito/code-indexer
cd code-indexer
npm install
npm run build
```

Requires Node.js 20.

## Scripts

```bash
npm run build       # compile TypeScript → dist/
npm test            # run test suite (vitest)
npm run test:watch  # watch mode
```

## Man page

```bash
man ./man/code-indexer.1
```

## Adding a language

1. Install the tree-sitter grammar package (e.g. `tree-sitter-python`)
2. Create `src/languages/python.ts` with a `LanguageConfig` — see `typescript.ts` or `kotlin.ts` for reference
3. Add the file extension mapping in `src/indexer.ts` (`EXT_MAP`)
4. Add the dynamic import in `getLangModule()`

See [How It Works](How-It-Works.md) for details on `LanguageConfig`.
