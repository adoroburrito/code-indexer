import { describe, it, expect, beforeAll } from 'vitest';
import { parseSource } from '../../parser.js';
import { typescriptConfig } from '../../languages/typescript.js';
import { kotlinConfig } from '../../languages/kotlin.js';

let tsModule: object;
let ktModule: object;

beforeAll(async () => {
  const ts = await import('tree-sitter-typescript');
  tsModule = (ts.default as { typescript: object }).typescript;
  const kt = await import('tree-sitter-kotlin');
  ktModule = kt.default as object;
});

describe('TypeScript parsing', () => {
  it('extracts function, class with methods, and interface', () => {
    const src = `
export function greet(name: string): string {
  return 'Hello ' + name;
}

export interface User {
  id: string;
  name: string;
}

export class UserService {
  private users: User[] = [];

  addUser(user: User): void {
    this.users.push(user);
  }

  findByName(name: string): User | undefined {
    return this.users.find(u => u.name === name);
  }
}
`.trim();

    const { symbols } = parseSource(src, typescriptConfig, tsModule);

    const fn = symbols.find(s => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.startLine).toBe(1);

    const iface = symbols.find(s => s.name === 'User');
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe('interface');

    const cls = symbols.find(s => s.name === 'UserService');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');

    const addUser = symbols.find(s => s.name === 'addUser');
    expect(addUser).toBeDefined();
    expect(addUser!.kind).toBe('method');

    const findByName = symbols.find(s => s.name === 'findByName');
    expect(findByName).toBeDefined();
    expect(findByName!.kind).toBe('method');
  });

  it('extracts line ranges correctly', () => {
    const src = `export interface User {\n  id: string;\n  name: string;\n}`;
    const { symbols } = parseSource(src, typescriptConfig, tsModule);
    const iface = symbols.find(s => s.name === 'User');
    expect(iface).toBeDefined();
    expect(iface!.startLine).toBe(1);
    expect(iface!.endLine).toBe(4);
  });

  it('extracts identifier references', () => {
    const src = `
function foo() {
  bar();
  baz();
}
`.trim();
    const { references } = parseSource(src, typescriptConfig, tsModule);
    const refNames = references.map(r => r.symbolName);
    expect(refNames).toContain('bar');
    expect(refNames).toContain('baz');
  });

  it('sets parent_symbol_id for methods inside classes', () => {
    const src = `
export class MyClass {
  myMethod(): void {}
}
`.trim();
    const { symbols } = parseSource(src, typescriptConfig, tsModule);
    const cls = symbols.find(s => s.kind === 'class');
    const method = symbols.find(s => s.kind === 'method');
    expect(cls).toBeDefined();
    expect(method).toBeDefined();
    const clsIdx = symbols.indexOf(cls!);
    expect(method!.parentSymbolId).toBe(clsIdx);
  });

  it('indexes module-level consts but not local variables', () => {
    const src = `
export const LIMIT = 100;
const helper = (x: number) => x * 2;

function process(items: string[]) {
  const result = [];
  const count = items.length;
  return result;
}
`.trim();
    const { symbols } = parseSource(src, typescriptConfig, tsModule);
    const names = symbols.map(s => s.name);
    expect(names).toContain('LIMIT');
    expect(names).toContain('helper');
    expect(names).toContain('process');
    expect(names).not.toContain('result');
    expect(names).not.toContain('count');
  });

  it('does not index destructured declarations (no simple name node)', () => {
    // Destructuring: variable_declarator has object_pattern as name, not an identifier.
    // extractNameFromLexicalDecl returns null → symbol is skipped (line 61 of parser.ts).
    const src = `const { a, b } = someObj;\nconst [x, y] = arr;`;
    const { symbols } = parseSource(src, typescriptConfig, tsModule);
    const names = symbols.map(s => s.name);
    expect(names).not.toContain('a');
    expect(names).not.toContain('b');
    expect(names).not.toContain('x');
    expect(names).not.toContain('y');
  });

  it('parentConstraints: does not index variables inside class methods', () => {
    const src = `
export class MyService {
  process() {
    const temp = 42;
    const helper = () => {};
  }
}
`.trim();
    const { symbols } = parseSource(src, typescriptConfig, tsModule);
    const names = symbols.map(s => s.name);
    expect(names).toContain('MyService');
    expect(names).not.toContain('temp');
    expect(names).not.toContain('helper');
  });
});

describe('Kotlin parsing', () => {
  it('extracts class with methods and top-level function', () => {
    const src = `
class UserService {
    private val users = mutableListOf<User>()

    fun addUser(user: User) {
        users.add(user)
    }

    fun findByName(name: String): User? {
        return users.find { it.name == name }
    }
}

fun greet(name: String): String {
    return "Hello \$name"
}
`.trim();

    const { symbols } = parseSource(src, kotlinConfig, ktModule);

    const cls = symbols.find(s => s.name === 'UserService');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');

    const addUser = symbols.find(s => s.name === 'addUser');
    expect(addUser).toBeDefined();
    expect(addUser!.kind).toBe('function');

    const greet = symbols.find(s => s.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.kind).toBe('function');
  });

  it('extracts references', () => {
    const src = `
fun foo() {
    bar()
    baz()
}
`.trim();
    const { references } = parseSource(src, kotlinConfig, ktModule);
    const refNames = references.map(r => r.symbolName);
    expect(refNames).toContain('bar');
    expect(refNames).toContain('baz');
  });

  it('sets parent_symbol_id for methods inside classes', () => {
    const src = `
class MyClass {
    fun myMethod() {}
}
`.trim();
    const { symbols } = parseSource(src, kotlinConfig, ktModule);
    const cls = symbols.find(s => s.kind === 'class');
    const method = symbols.find(s => s.name === 'myMethod');
    expect(cls).toBeDefined();
    expect(method).toBeDefined();
    const clsIdx = symbols.indexOf(cls!);
    expect(method!.parentSymbolId).toBe(clsIdx);
  });
});
