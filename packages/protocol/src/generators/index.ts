import type { Registry } from '../ir.js';
import { generateCpp } from './cpp.js';
import { generateLua } from './lua.js';
import { generateRust } from './rust.js';
import { generateTypeScript } from './typescript.js';

export interface Artifact {
  /** Path relative to `packages/protocol/generated`. */
  path: string;
  contents: string;
  language: string;
}

/**
 * Renders every artifact. Pure — it touches no filesystem, so the generate and check
 * commands share one code path and cannot drift from each other.
 */
export function renderAll(registry: Registry): Artifact[] {
  return [
    {
      path: 'typescript/protocol.ts',
      contents: generateTypeScript(registry),
      language: 'TypeScript',
    },
    { path: 'rust/protocol.rs', contents: generateRust(registry), language: 'Rust' },
    { path: 'cpp/fiveprotect_protocol.hpp', contents: generateCpp(registry), language: 'C++' },
    { path: 'lua/protocol.lua', contents: generateLua(registry), language: 'Lua' },
  ];
}

export { generateCpp, generateLua, generateRust, generateTypeScript };
