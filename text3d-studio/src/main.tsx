import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
import { createLogger, dumpLogs, getLogEntries } from './utils/logger';

const log = createLogger('bootstrap');

// Logs stay out of the UI, but are reachable from the devtools console:
//   __text3d.dump()  →  the full session log as text
Object.defineProperty(window, '__text3d', {
  value: { dump: dumpLogs, entries: getLogEntries },
  configurable: true,
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Élément #root introuvable.');
}

// Any error that escapes a component would otherwise leave a blank window.
window.addEventListener('error', (event) => {
  log.error('Erreur non gérée', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  log.error('Promesse rejetée', event.reason);
});

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

log.info('Interface initialisée');
