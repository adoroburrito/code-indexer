import type { LanguageConfig } from './types.js';

export const kotlinConfig: LanguageConfig = {
  language: 'kotlin',
  extensions: ['.kt', '.kts'],
  symbolMap: {
    function_declaration: 'function',
    class_declaration: 'class',
    object_declaration: 'object',
    property_declaration: 'property',
    companion_object: 'object',
    secondary_constructor: 'constructor',
    enum_entry: 'enum',
  },
  nameNodeTypes: ['simple_identifier', 'type_identifier'],
  parentConstraints: {
    // Only index properties at class/object/file level — not local vals inside function bodies
    property_declaration: ['class_body', 'object_declaration', 'companion_object', 'source_file'],
  },
};
