import type { LanguageConfig } from './types.js';

export const rustConfig: LanguageConfig = {
  language: 'rust',
  extensions: ['.rs'],
  symbolMap: {
    function_item: 'function',
    struct_item: 'class',
    enum_item: 'enum',
    trait_item: 'interface',
    type_item: 'type',
    const_item: 'variable',
    static_item: 'variable',
  },
  nameNodeTypes: ['identifier', 'type_identifier'],
  parentConstraints: {
    // Only index consts/statics at module level — not local consts inside function bodies
    const_item: ['source_file', 'declaration_list'],
    static_item: ['source_file', 'declaration_list'],
  },
};
