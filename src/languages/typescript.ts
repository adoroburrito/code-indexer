import type { LanguageConfig } from './types.js';

export const typescriptConfig: LanguageConfig = {
  language: 'typescript',
  extensions: ['.ts', '.tsx'],
  symbolMap: {
    function_declaration: 'function',
    class_declaration: 'class',
    class_expression: 'class',
    interface_declaration: 'interface',
    method_definition: 'method',
    lexical_declaration: 'variable',
    enum_declaration: 'enum',
    type_alias_declaration: 'type',
  },
  nameNodeTypes: ['identifier', 'type_identifier', 'property_identifier'],
  parentConstraints: {
    // Only index const/let at module level — not local variables inside function bodies
    lexical_declaration: ['program', 'export_statement'],
  },
};
