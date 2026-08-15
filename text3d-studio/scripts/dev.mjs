/**
 * `npm run dev` — starts Vite, compiles the Electron entry points, then opens
 * the desktop window pointed at the dev server.
 *
 * Two portability rules drive this script:
 *
 *  - Never spawn `npm`. On Windows the npm CLI is a `.cmd` shim, and since the
 *    fix for CVE-2024-27980 Node refuses to spawn `.cmd`/`.bat` without
 *    `shell: true` (it throws EINVAL). We call the TypeScript compiler with the
 *    current Node binary instead, which behaves identically everywhere.
 *  - Never hard-fail on the desktop path. Headless machines and broken Electron
 *    installs fall back to browser mode with the dev server still running.
 *
 * Use `npm run dev:web` to force browser mode.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

function hasDisplay() {
  if (process.platform !== 'linux') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(command)} → code ${code}`)),
    );
  });
}

/** Path to tsc's JS entry point — a plain `.js` file, so no shell shim. */
function resolveTsc() {
  const entry = path.join(path.dirname(require.resolve('typescript')), '..', 'bin', 'tsc');
  if (existsSync(entry)) return entry;
  // Fallback for layouts where typescript resolves elsewhere.
  const nested = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(nested)) return nested;
  throw new Error("TypeScript est introuvable. Lancez d'abord `npm install`.");
}

async function buildElectron() {
  await run(process.execPath, [resolveTsc(), '-p', path.join(root, 'electron', 'tsconfig.json')]);
  // Writes the CommonJS marker next to the compiled output.
  await import('./finalize-electron.mjs');
}

async function launchElectron(url) {
  const module = await import('electron');
  const electronPath = typeof module.default === 'string' ? module.default : module.default?.default;
  if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
    throw new Error("le binaire Electron est introuvable (réinstallez avec `npm install`)");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [path.join(root, 'dist-electron', 'main.js')], {
      cwd: root,
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, VITE_DEV_SERVER_URL: url },
    });
    child.on('error', reject);
    child.on('spawn', () => resolve(child));
  });
}

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error("Vite n'a pas exposé d'URL locale.");
server.printUrls();

function browserMode(reason) {
  console.log(`\n[dev] ${reason}`);
  console.log(`[dev] L'application reste disponible sur ${url} (Chrome/Edge recommandés).\n`);
}

if (!hasDisplay()) {
  browserMode('Aucun affichage graphique détecté — mode navigateur.');
} else {
  try {
    console.log('\n[dev] Compilation des entrées Electron…');
    await buildElectron();

    const startedAt = Date.now();
    const child = await launchElectron(url);
    console.log('[dev] Fenêtre Electron lancée.\n');

    child.on('exit', (code) => {
      // A crash in the first seconds means the window never really opened
      // (missing GPU, sandbox refused, bad install…). Keep serving the app
      // instead of leaving the user with a dead terminal.
      if (code !== 0 && Date.now() - startedAt < 5000) {
        browserMode(`Electron s'est arrêté immédiatement (code ${code}) — mode navigateur.`);
        return;
      }
      void server.close().then(() => process.exit(0));
    });
  } catch (error) {
    browserMode(`Lancement du bureau impossible (${error.message}) — mode navigateur.`);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
