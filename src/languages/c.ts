import type { LanguageConfig, SyntaxNode } from './types.js';

// Follow the declarator chain (pointer_declarator, function_declarator, array_declarator, etc.)
// to find the innermost identifier or type_identifier, which is the declared name.
function followDeclarator(node: SyntaxNode | null): SyntaxNode | null {
  while (node) {
    if (node.type === 'identifier' || node.type === 'type_identifier') return node;
    const inner = node.childForFieldName('declarator');
    if (!inner) return null;
    node = inner;
  }
  return null;
}

export const cConfig: LanguageConfig = {
  language: 'c',
  extensions: ['.c', '.h'],
  symbolMap: {
    function_definition: 'function',
    struct_specifier: 'class',
    union_specifier: 'class',
    enum_specifier: 'enum',
    type_definition: 'type',
    preproc_def: 'variable',
    preproc_function_def: 'function',
  },
  nameNodeTypes: ['identifier', 'type_identifier'],
  filterNode(node) {
    // For struct/union/enum: only index definitions (have a body), not type references.
    // e.g. index `struct foo { ... }` but not `struct foo *ptr` inside a function.
    if (
      node.type === 'struct_specifier' ||
      node.type === 'union_specifier' ||
      node.type === 'enum_specifier'
    ) {
      return node.childForFieldName('body') !== null;
    }
    return true;
  },
  parentConstraints: {
    // Only index structs/unions/enums at file scope or inside a typedef —
    // avoids noise from locally-scoped anonymous struct types.
    struct_specifier: ['translation_unit', 'type_definition', 'declaration'],
    union_specifier: ['translation_unit', 'type_definition', 'declaration'],
    enum_specifier: ['translation_unit', 'type_definition', 'declaration'],
    type_definition: ['translation_unit'],
  },
  nameExtractor(node) {
    // function_definition: type declarator(params) { body }
    // The name is buried in the declarator chain under the 'declarator' field.
    if (node.type === 'function_definition') {
      return followDeclarator(node.childForFieldName('declarator'));
    }

    // type_definition (typedef): typedef <type> <declarator>;
    // The declared alias is the last identifier in the declarator chain.
    if (node.type === 'type_definition') {
      return followDeclarator(node.childForFieldName('declarator'));
    }

    // struct/union/enum: name is in the 'name' field (type_identifier), handled by default.
    // preproc_def / preproc_function_def: name is in the 'name' field (identifier), handled by default.
    return null;
  },
};
