import Parser from 'tree-sitter';
import type { LanguageConfig, ExtractedSymbol, ExtractedReference } from './languages/types.js';

export interface ParseResult {
  symbols: ExtractedSymbol[];
  references: ExtractedReference[];
}

// Cache parsers per language grammar object identity
const parserCache = new WeakMap<object, Parser>();

function getParser(languageModule: object): Parser {
  if (!parserCache.has(languageModule)) {
    const p = new Parser();
    p.setLanguage(languageModule as Parameters<Parser['setLanguage']>[0]);
    parserCache.set(languageModule, p);
  }
  return parserCache.get(languageModule)!;
}

export function parseSource(
  source: string,
  config: LanguageConfig,
  languageModule: object
): ParseResult {
  const parser = getParser(languageModule);
  const tree = parser.parse(source);

  const symbols: ExtractedSymbol[] = [];
  const references: ExtractedReference[] = [];
  // Set of nodes that are the "name" identifier of a symbol definition
  const definitionNameNodes = new Set<Parser.SyntaxNode>();

  function getNameNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    // Strategy 0: language-specific custom extractor
    if (config.nameExtractor) {
      const result = config.nameExtractor(node);
      if (result) return result as Parser.SyntaxNode;
    }
    // Strategy 1: tree-sitter named field 'name'
    const named = node.childForFieldName('name');
    if (named && config.nameNodeTypes.includes(named.type)) return named;
    // Strategy 2: first child whose type is a known name type
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)!;
      if (config.nameNodeTypes.includes(c.type)) return c;
    }
    return null;
  }

  function isSymbolNode(nodeType: string): boolean {
    return nodeType in config.symbolMap;
  }

  // Special handling for TypeScript lexical_declaration:
  // extracts the declared name from a variable_declarator child.
  // Returns null for destructured declarations (object/array patterns have no simple name node).
  // Scope filtering (module-level only) is handled upstream by parentConstraints.
  function extractNameFromLexicalDecl(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    // Find the variable_declarator child
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)!;
      if (c.type === 'variable_declarator') {
        const nameChild = c.childForFieldName('name') ?? c.child(0);
        if (nameChild && config.nameNodeTypes.includes(nameChild.type)) return nameChild;
      }
    }
    return null;
  }

  function walk(node: Parser.SyntaxNode, parentIdx: number | null): void {
    if (isSymbolNode(node.type)) {
      const constraints = config.parentConstraints?.[node.type];
      if (constraints && !constraints.includes(node.parent?.type ?? '')) {
        // Constrained node in a disallowed context (e.g. local variable) — skip symbol, walk children
        for (let i = 0; i < node.childCount; i++) walk(node.child(i)!, parentIdx);
        return;
      }

      if (config.filterNode && !config.filterNode(node)) {
        // Language-specific filter rejected this node — skip symbol, walk children
        for (let i = 0; i < node.childCount; i++) walk(node.child(i)!, parentIdx);
        return;
      }

      const kind = config.symbolMap[node.type];
      let nameNode: Parser.SyntaxNode | null;

      if (node.type === 'lexical_declaration') {
        nameNode = extractNameFromLexicalDecl(node);
      } else {
        nameNode = getNameNode(node);
      }

      if (nameNode) {
        definitionNameNodes.add(nameNode);
        const localIdx = symbols.length;
        symbols.push({
          name: nameNode.text,
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          parentSymbolId: parentIdx,
        });

        // Walk children with this symbol as parent
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i)!, localIdx);
        }
        return;
      }
    }

    // Not a symbol node (or no name found) — walk children
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, parentIdx);
    }

    // Collect identifier references (leaf nodes not part of a definition name)
    if (
      config.nameNodeTypes.includes(node.type) &&
      node.childCount === 0 &&
      !definitionNameNodes.has(node) &&
      node.text.trim().length > 0
    ) {
      references.push({
        symbolName: node.text,
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
      });
    }
  }

  walk(tree.rootNode, null);

  return { symbols, references };
}
