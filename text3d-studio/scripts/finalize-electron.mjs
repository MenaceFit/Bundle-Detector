/**
 * The root package.json declares `"type": "module"` for the Vite/React side,
 * but the Electron main + preload bundles are emitted as CommonJS (required for
 * a sandboxed preload). Dropping a scoped package.json marker next to them keeps
 * Node from re-interpreting those files as ESM.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'dist-electron');

await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  'utf8',
);

console.log('[build] dist-electron/package.json written (commonjs marker)');
