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

export interface LanguageConfig {
  language: string;
  extensions: string[];
  // Maps tree-sitter node type -> symbol kind
  symbolMap: Record<string, string>;
  // Node types that contain the symbol name (checked in order)
  nameNodeTypes: string[];
  // Node types that are only indexed when their direct AST parent is in the allowed set.
  // Used to suppress local variable noise while keeping module-level declarations.
  parentConstraints?: Record<string, string[]>;
}
