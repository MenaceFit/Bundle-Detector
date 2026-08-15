/**
 * `npm run dev` — starts Vite, compiles the Electron entry points, then opens
 * the desktop window pointed at the dev server.
 *
 * On a headless machine (CI, container, SSH without X) Electron cannot open a
 * window, so we detect that up front and keep serving the browser build instead
 * of failing. Use `npm run dev:web` to force that mode.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npmCli = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function hasDisplay() {
  if (process.platform !== 'linux') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} → ${code}`))));
  });
}

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error("Vite n'a pas exposé d'URL locale.");
server.printUrls();

if (!hasDisplay()) {
  console.log('\n[dev] Aucun affichage graphique détecté — mode navigateur.');
  console.log(`[dev] Ouvrez ${url} dans un navigateur (Chrome/Edge recommandé).\n`);
} else {
  console.log('\n[dev] Compilation des entrées Electron…');
  await run(npmCli, ['run', 'build:electron']);

  const { default: electronPath } = await import('electron');
  const child = spawn(electronPath, [path.join(root, 'dist-electron/main.js')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });

  child.on('exit', () => {
    void server.close().then(() => process.exit(0));
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
