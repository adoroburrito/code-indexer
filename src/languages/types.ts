export interface ExtractedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  parentSymbolId?: number | null;
}

export interface ExtractedReference {
  symbolName: string;
  line: number;
  column: number;
}

// Minimal structural interface so language configs can use nameExtractor
// without importing tree-sitter directly.
export interface SyntaxNode {
  type: string;
  text: string;
  childCount: number;
  child(index: number): SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
  parent: SyntaxNode | null;
}

export interface LanguageConfig {
  language: string;
  extensions: string[];
  // Maps tree-sitter node type -> symbol kind
  symbolMap: Record<string, string>;
  // Node types that contain the symbol name (checked in order)
  nameNodeTypes: string[];
  // Node types that are only indexed when their direct AST parent is in the allowed set.
  parentConstraints?: Record<string, string[]>;
  // Optional custom name extractor — called first; return null to fall through to default.
  nameExtractor?: (node: SyntaxNode) => SyntaxNode | null;
  // Optional node filter — return false to skip a symbol node entirely (no name extracted, no symbol recorded).
  filterNode?: (node: SyntaxNode) => boolean;
}
