import { useEffect, useMemo, useState } from 'react';
import { Field } from '../ui/Field';
import { useLayerValue } from '@/state/hooks';
import { useStore } from '@/state/store';
import {
  importFont,
  importFontFile,
  listSystemFonts,
  loadFavorites,
  loadImportedFonts,
  loadRecent,
  pushRecent,
  saveFavorites,
} from '@/fonts/fontManager';

interface FontState {
  system: string[];
  imported: string[];
  favorites: string[];
  recent: string[];
}

/**
 * Font browser: favourites, recently used, imported files and installed system
 * families. Nothing is bundled with the app — imported files stay in the local
 * IndexedDB store and are re-registered on startup.
 */
export function FontSelector() {
  const family = useLayerValue<string>('typography.fontFamily') ?? 'Arial';
  const patchLayer = useStore((state) => state.patchLayer);
  const notify = useStore((state) => state.notify);

  const [fonts, setFonts] = useState<FontState>({
    system: [],
    imported: [],
    favorites: loadFavorites(),
    recent: loadRecent(),
  });
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [imported, system] = await Promise.all([loadImportedFonts(), listSystemFonts()]);
      if (cancelled) return;
      setFonts((state) => ({ ...state, system, imported }));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const match = (name: string): boolean =>
      needle.length === 0 || name.toLowerCase().includes(needle);

    return [
      { label: 'Favoris', items: fonts.favorites.filter(match) },
      { label: 'Récentes', items: fonts.recent.filter(match) },
      { label: 'Importées', items: fonts.imported.filter(match) },
      { label: 'Système', items: fonts.system.filter(match) },
    ].filter((group) => group.items.length > 0);
  }, [fonts, filter]);

  const select = (next: string): void => {
    patchLayer('typography.fontFamily', next);
    setFonts((state) => ({ ...state, recent: pushRecent(next) }));
  };

  const toggleFavorite = (name: string): void => {
    const favorites = fonts.favorites.includes(name)
      ? fonts.favorites.filter((f) => f !== name)
      : [...fonts.favorites, name];
    saveFavorites(favorites);
    setFonts((state) => ({ ...state, favorites }));
  };

  const importFiles = async (): Promise<void> => {
    try {
      if (window.desktop) {
        const files = await window.desktop.importFonts();
        const names: string[] = [];
        for (const file of files) {
          const name = await importFont(file.name, file.data);
          if (name) names.push(name);
        }
        if (names.length > 0) {
          setFonts((state) => ({
            ...state,
            imported: [...new Set([...state.imported, ...names])],
          }));
          select(names[0]!);
          notify('success', `Police importée : ${names.join(', ')}`);
        }
        return;
      }

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.ttf,.otf,.woff,.woff2';
      input.multiple = true;
      input.onchange = async () => {
        const names: string[] = [];
        for (const file of [...(input.files ?? [])]) {
          const name = await importFontFile(file);
          if (name) names.push(name);
        }
        if (names.length === 0) {
          notify('error', 'Aucune police valide dans la sélection.');
          return;
        }
        setFonts((state) => ({ ...state, imported: [...new Set([...state.imported, ...names])] }));
        select(names[0]!);
        notify('success', `Police importée : ${names.join(', ')}`);
      };
      input.click();
    } catch (error) {
      notify('error', `Import de police impossible : ${String(error)}`);
    }
  };

  return (
    <Field label="Police" path="typography.fontFamily">
      <div className="field-row">
        <input
          className="input"
          placeholder={loading ? 'Chargement…' : 'Rechercher une police…'}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm btn-icon"
          title="Importer une police locale"
          onClick={() => void importFiles()}
        >
          +
        </button>
      </div>

      <div
        style={{
          maxHeight: 188,
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          background: 'var(--bg-2)',
        }}
      >
        {groups.length === 0 && <div className="hint" style={{ padding: 10 }}>Aucun résultat.</div>}
        {groups.map((group) => (
          <div key={group.label}>
            <div
              style={{
                position: 'sticky',
                top: 0,
                background: 'var(--bg-3)',
                padding: '3px 8px',
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-2)',
              }}
            >
              {group.label}
            </div>
            {group.items.map((name) => (
              <div
                key={`${group.label}-${name}`}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px' }}
              >
                <button
                  type="button"
                  onClick={() => select(name)}
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    padding: '5px 6px',
                    borderRadius: 4,
                    fontFamily: `"${name}", sans-serif`,
                    fontSize: 14,
                    color: name === family ? 'var(--accent)' : 'var(--text-1)',
                    background: name === family ? 'var(--accent-soft)' : 'transparent',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={name}
                >
                  {name}
                </button>
                <button
                  type="button"
                  className="preset-star"
                  onClick={() => toggleFavorite(name)}
                  title="Favori"
                  style={{ color: fonts.favorites.includes(name) ? 'var(--accent)' : undefined }}
                >
                  {fonts.favorites.includes(name) ? '★' : '☆'}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Field>
  );
}
