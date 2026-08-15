import { readJson, STORAGE_KEYS, writeJson } from '@/project/storage';
import { createLogger } from '@/utils/logger';

const log = createLogger('fonts');

const DB_NAME = 'text3d-fonts';
const DB_STORE = 'files';

/**
 * Families probed with `document.fonts.check` when the Local Font Access API is
 * unavailable. Nothing is bundled: only fonts already installed on the machine
 * can be selected, which keeps the project clear of licensing issues.
 */
const CANDIDATE_FAMILIES = [
  'Arial', 'Arial Black', 'Arial Narrow', 'Helvetica', 'Helvetica Neue',
  'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Franklin Gothic Medium',
  'Gill Sans', 'Futura', 'Century Gothic', 'Optima', 'Candara', 'Calibri',
  'Segoe UI', 'Segoe UI Black', 'Roboto', 'Open Sans', 'Noto Sans', 'Ubuntu',
  'Cantarell', 'DejaVu Sans', 'Liberation Sans', 'FreeSans', 'Nimbus Sans',
  'Times New Roman', 'Georgia', 'Garamond', 'Palatino', 'Bookman', 'Baskerville',
  'DejaVu Serif', 'Liberation Serif', 'Cambria', 'Constantia', 'Rockwell',
  'Courier New', 'Consolas', 'Monaco', 'Menlo', 'DejaVu Sans Mono',
  'Liberation Mono', 'Source Code Pro', 'Comic Sans MS', 'Papyrus', 'Copperplate',
];

export interface StoredFont {
  name: string;
  data: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'name' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB indisponible'));
  });
}

async function putFont(font: StoredFont): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(font);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Écriture impossible'));
  });
  db.close();
}

async function allFonts(): Promise<StoredFont[]> {
  const db = await openDb();
  const result = await new Promise<StoredFont[]>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const request = tx.objectStore(DB_STORE).getAll();
    request.onsuccess = () => resolve(request.result as StoredFont[]);
    request.onerror = () => reject(request.error ?? new Error('Lecture impossible'));
  });
  db.close();
  return result;
}

async function registerFont(name: string, data: ArrayBuffer): Promise<boolean> {
  try {
    const face = new FontFace(name, data);
    await face.load();
    document.fonts.add(face);
    return true;
  } catch (error) {
    log.error(`Police « ${name} » invalide`, error);
    return false;
  }
}

/** Re-registers every previously imported font. Called once at startup. */
export async function loadImportedFonts(): Promise<string[]> {
  try {
    const stored = await allFonts();
    const loaded: string[] = [];
    for (const font of stored) {
      // FontFace consumes the buffer, so hand it a copy.
      if (await registerFont(font.name, font.data.slice(0))) loaded.push(font.name);
    }
    if (loaded.length > 0) log.info('Polices importées rechargées', loaded);
    return loaded;
  } catch (error) {
    log.warn('Impossible de recharger les polices importées', error);
    return [];
  }
}

/** Registers and persists a font file. Returns the family name on success. */
export async function importFont(name: string, data: ArrayBuffer): Promise<string | null> {
  const family = name.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/, '').trim();
  if (family.length === 0) return null;
  const ok = await registerFont(family, data.slice(0));
  if (!ok) return null;
  try {
    await putFont({ name: family, data });
  } catch (error) {
    log.warn('Police non persistée (elle restera active jusqu’à la fermeture)', error);
  }
  return family;
}

export async function importFontFile(file: File): Promise<string | null> {
  return importFont(file.name, await file.arrayBuffer());
}

/**
 * Enumerates system families. Uses the Local Font Access API when the user
 * grants it, otherwise probes a candidate list with `document.fonts.check`,
 * which reliably detects installed families without any permission prompt.
 */
export async function listSystemFonts(): Promise<string[]> {
  if (typeof window.queryLocalFonts === 'function') {
    try {
      const fonts = await window.queryLocalFonts();
      const families = [...new Set(fonts.map((font) => font.family))].sort((a, b) =>
        a.localeCompare(b),
      );
      if (families.length > 0) {
        log.info('Polices système énumérées', { count: families.length });
        return families;
      }
    } catch (error) {
      log.warn('Local Font Access refusé, retour à la détection par sondage', error);
    }
  }

  const available = CANDIDATE_FAMILIES.filter((family) => {
    try {
      return document.fonts.check(`16px "${family}"`);
    } catch {
      return false;
    }
  });

  // Always keep a usable baseline even if detection finds nothing.
  const result = available.length > 0 ? available : ['sans-serif', 'serif', 'monospace'];
  return [...new Set(result)].sort((a, b) => a.localeCompare(b));
}

export function loadFavorites(): string[] {
  return readJson<string[]>(STORAGE_KEYS.fontFavorites, []);
}

export function saveFavorites(families: string[]): void {
  writeJson(STORAGE_KEYS.fontFavorites, families);
}

export function loadRecent(): string[] {
  return readJson<string[]>(STORAGE_KEYS.fontRecent, []);
}

export function pushRecent(family: string): string[] {
  const recent = [family, ...loadRecent().filter((f) => f !== family)].slice(0, 8);
  writeJson(STORAGE_KEYS.fontRecent, recent);
  return recent;
}
