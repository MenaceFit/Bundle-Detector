import { create } from 'zustand';
import type {
  EasingKind,
  ExportSettings,
  Layer,
  PreviewSettings,
  Project,
  StylePreset,
  TextLayer,
  TimelineSettings,
  Track,
} from '@/types';
import { createProject, createTextLayer } from '@/project/defaults';
import { deserializeProject } from '@/project/serialize';
import { deepClone, generateId, getPath, setPath, type Plain } from '@/utils/object';
import {
  duplicateKeyframe as duplicateKf,
  moveKeyframe as moveKf,
  removeKeyframe as removeKf,
  rescaleTrack,
  setKeyframeEasing as setKfEasing,
  upsertKeyframe,
} from '@/animation/keyframes';
import { buildPresetTracks, mergeTracks } from '@/animation/presets';
import { randomStyle, randomTransformTweaks } from '@/project/randomize';
import { cloneStyle } from '@/project/defaults';
import { clamp } from '@/utils/math';
import { createLogger } from '@/utils/logger';

const log = createLogger('store');

const MAX_HISTORY = 120;
/** Two commits with the same key inside this window collapse into one. */
const COALESCE_MS = 700;

export type ToolSection = 'text' | 'style' | '3d' | 'shadow' | 'animation' | 'effects' | 'presets';

/** Top-level workspaces. Each owns its document; they share the engines. */
export type Workspace = 'text3d' | 'captions';

export interface Notification {
  id: string;
  kind: 'info' | 'success' | 'error';
  message: string;
}

interface HistoryEntry {
  project: Project;
  label: string;
}

export interface AppState {
  project: Project;
  filePath: string | null;
  dirty: boolean;

  past: HistoryEntry[];
  future: HistoryEntry[];
  lastCommitKey: string | null;
  lastCommitAt: number;

  time: number;
  playing: boolean;

  zoom: number;
  panX: number;
  panY: number;
  workspace: Workspace;
  tool: ToolSection;
  exportOpen: boolean;
  referenceImage: string | null;

  notifications: Notification[];

  /* ---------------------------------------------------------- selectors */
  activeLayer: () => TextLayer;

  /* ------------------------------------------------------------ project */
  newProject: () => void;
  loadProjectFromContent: (content: string, filePath: string | null) => void;
  setProject: (project: Project, filePath?: string | null) => void;
  markSaved: (filePath: string | null) => void;
  setProjectName: (name: string) => void;
  setCanvasSize: (width: number, height: number) => void;
  updatePreview: (patch: Partial<PreviewSettings>) => void;

  /* ------------------------------------------------------------- layers */
  addLayer: () => void;
  duplicateLayer: (id?: string) => void;
  removeLayer: (id?: string) => void;
  selectLayer: (id: string) => void;
  moveLayer: (id: string, direction: -1 | 1) => void;
  updateLayerMeta: (id: string, patch: Partial<Pick<Layer, 'name' | 'visible' | 'locked'>>) => void;

  /* --------------------------------------------------------- properties */
  patchLayer: (path: string, value: unknown, options?: { commitKey?: string }) => void;
  patchLayerMany: (entries: Array<[string, unknown]>, options?: { commitKey?: string }) => void;
  setText: (text: string) => void;
  applyStylePreset: (preset: StylePreset) => void;
  applyRandomStyle: () => void;
  resetTransform: () => void;

  /* ----------------------------------------------------------- timeline */
  setTimeline: (patch: Partial<TimelineSettings>) => void;
  setTime: (time: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stop: () => void;
  restart: () => void;
  stepFrame: (direction: -1 | 1) => void;

  /* ---------------------------------------------------------- keyframes */
  toggleKeyframe: (property: string) => void;
  removeKeyframe: (property: string, keyframeId: string) => void;
  moveKeyframe: (property: string, keyframeId: string, time: number) => void;
  duplicateKeyframe: (property: string, keyframeId: string) => void;
  setKeyframeEasing: (property: string, keyframeId: string, easing: EasingKind) => void;
  removeTrack: (property: string) => void;
  clearAnimation: () => void;
  applyAnimationPreset: (presetId: string) => void;

  /* ------------------------------------------------------------- export */
  setExportSettings: (patch: Partial<ExportSettings>) => void;
  setExportOpen: (open: boolean) => void;

  /* ------------------------------------------------------------ history */
  commit: (label: string, key?: string) => void;
  undo: () => void;
  redo: () => void;

  /* ----------------------------------------------------------------- ui */
  setWorkspace: (workspace: Workspace) => void;
  setTool: (tool: ToolSection) => void;
  setZoom: (zoom: number) => void;
  zoomBy: (factor: number) => void;
  setPan: (x: number, y: number) => void;
  resetView: () => void;
  setReferenceImage: (dataUrl: string | null) => void;

  notify: (kind: Notification['kind'], message: string) => void;
  dismissNotification: (id: string) => void;
}

export const useStore = create<AppState>((set, get) => {
  /**
   * Applies `mutate` to a clone of the project, pushing a history entry first.
   * Every mutating action goes through here, which is what makes undo total.
   */
  const edit = (
    label: string,
    mutate: (project: Project) => void,
    options: { commitKey?: string; history?: boolean } = {},
  ): void => {
    const state = get();
    const next = deepClone(state.project);
    mutate(next);
    next.modifiedAt = new Date().toISOString();

    const patch: Partial<AppState> = { project: next, dirty: true, future: [] };

    if (options.history !== false) {
      const now = Date.now();
      const key = options.commitKey;
      const coalesce =
        key !== undefined && key === state.lastCommitKey && now - state.lastCommitAt < COALESCE_MS;

      if (!coalesce) {
        patch.past = [...state.past, { project: state.project, label }].slice(-MAX_HISTORY);
      }
      patch.lastCommitKey = key ?? null;
      patch.lastCommitAt = now;
    }

    set(patch);
  };

  const withActiveLayer = (
    label: string,
    mutate: (layer: TextLayer, project: Project) => void,
    options: { commitKey?: string } = {},
  ): void => {
    edit(
      label,
      (project) => {
        const layer = project.layers.find((l) => l.id === project.activeLayerId);
        if (!layer || layer.locked) return;
        mutate(layer, project);
      },
      options,
    );
  };

  return {
    project: createProject(),
    filePath: null,
    dirty: false,

    past: [],
    future: [],
    lastCommitKey: null,
    lastCommitAt: 0,

    time: 0,
    playing: false,

    zoom: 1,
    panX: 0,
    panY: 0,
    workspace: 'text3d',
    tool: 'text',
    exportOpen: false,
    referenceImage: null,

    notifications: [],

    activeLayer: () => {
      const { project } = get();
      return project.layers.find((l) => l.id === project.activeLayerId) ?? project.layers[0]!;
    },

    /* ---------------------------------------------------------- project */

    newProject: () => {
      set({
        project: createProject(),
        filePath: null,
        dirty: false,
        past: [],
        future: [],
        time: 0,
        playing: false,
      });
    },

    loadProjectFromContent: (content, filePath) => {
      const project = deserializeProject(content);
      set({
        project,
        filePath,
        dirty: false,
        past: [],
        future: [],
        time: 0,
        playing: false,
      });
      log.info('Projet chargé', { name: project.name, layers: project.layers.length });
    },

    setProject: (project, filePath) => {
      set({
        project,
        filePath: filePath === undefined ? get().filePath : filePath,
        dirty: false,
        past: [],
        future: [],
        time: 0,
      });
    },

    markSaved: (filePath) => set({ filePath, dirty: false }),

    setProjectName: (name) =>
      edit('Renommer le projet', (project) => {
        project.name = name;
      }, { commitKey: 'project.name' }),

    setCanvasSize: (width, height) =>
      edit('Taille du canvas', (project) => {
        project.canvas.width = clamp(Math.round(width), 16, 16384);
        project.canvas.height = clamp(Math.round(height), 16, 16384);
      }, { commitKey: 'canvas.size' }),

    updatePreview: (patch) =>
      edit('Aperçu', (project) => {
        project.canvas.preview = { ...project.canvas.preview, ...patch };
      }, { commitKey: 'canvas.preview' }),

    /* ----------------------------------------------------------- layers */

    addLayer: () =>
      edit('Ajouter un calque', (project) => {
        const layer = createTextLayer({ name: `Texte ${project.layers.length + 1}` });
        project.layers.push(layer);
        project.activeLayerId = layer.id;
      }),

    duplicateLayer: (id) =>
      edit('Dupliquer le calque', (project) => {
        const sourceId = id ?? project.activeLayerId;
        const index = project.layers.findIndex((l) => l.id === sourceId);
        const source = project.layers[index];
        if (!source) return;
        const copy: TextLayer = {
          ...deepClone(source),
          id: generateId('layer'),
          name: `${source.name} (copie)`,
        };
        // Fresh ids so keyframes of the copy are independent.
        copy.animation.tracks = copy.animation.tracks.map((track) => ({
          ...track,
          keyframes: track.keyframes.map((kf) => ({ ...kf, id: generateId('kf') })),
        }));
        project.layers.splice(index + 1, 0, copy);
        project.activeLayerId = copy.id;
      }),

    removeLayer: (id) =>
      edit('Supprimer le calque', (project) => {
        if (project.layers.length <= 1) return;
        const targetId = id ?? project.activeLayerId;
        project.layers = project.layers.filter((l) => l.id !== targetId);
        if (!project.layers.some((l) => l.id === project.activeLayerId)) {
          project.activeLayerId = project.layers[0]!.id;
        }
      }),

    // Selection is view state, not a document edit: it must not mark the
    // project dirty nor push a history entry.
    selectLayer: (id) => {
      const { project } = get();
      if (project.activeLayerId === id || !project.layers.some((l) => l.id === id)) return;
      set({ project: { ...project, activeLayerId: id } });
    },

    moveLayer: (id, direction) =>
      edit('Réordonner les calques', (project) => {
        const index = project.layers.findIndex((l) => l.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= project.layers.length) return;
        const [layer] = project.layers.splice(index, 1);
        if (layer) project.layers.splice(target, 0, layer);
      }),

    updateLayerMeta: (id, patch) =>
      edit('Modifier le calque', (project) => {
        const layer = project.layers.find((l) => l.id === id);
        if (layer) Object.assign(layer, patch);
      }),

    /* ------------------------------------------------------- properties */

    patchLayer: (path, value, options) => {
      get().patchLayerMany([[path, value]], options);
    },

    /**
     * Writes one or more properties on the active layer.
     *
     * When a property is already animated, the edit lands on a keyframe at the
     * current time instead of the static value — the behaviour every motion
     * tool has, and the reason changing a colour mid-playback does not silently
     * do nothing.
     */
    patchLayerMany: (entries, options) => {
      const { time } = get();
      withActiveLayer(
        'Modifier une propriété',
        (layer) => {
          for (const [path, value] of entries) {
            setPath(layer as unknown as Plain, path, value);
            const track = layer.animation.tracks.find((t) => t.property === path);
            if (track && track.keyframes.length > 0) {
              const updated = upsertKeyframe(track, time, value as never);
              layer.animation.tracks = layer.animation.tracks.map((t) =>
                t.property === path ? updated : t,
              );
            }
          }
        },
        options?.commitKey ? { commitKey: options.commitKey } : {},
      );
    },

    setText: (text) =>
      withActiveLayer('Modifier le texte', (layer) => {
        layer.text = text;
      }, { commitKey: 'layer.text' }),

    applyStylePreset: (preset) =>
      withActiveLayer('Appliquer un preset', (layer) => {
        layer.style = cloneStyle(preset.style);
        if (preset.effects) {
          layer.effects = { ...layer.effects, ...deepClone(preset.effects) };
        }
        Object.assign(layer.typography, preset.typography);
      }),

    applyRandomStyle: () =>
      withActiveLayer('Style aléatoire', (layer) => {
        layer.style = randomStyle();
        const tweaks = randomTransformTweaks();
        layer.transform.rotation = tweaks.rotation;
        layer.transform.perspective = tweaks.perspective;
      }),

    resetTransform: () =>
      withActiveLayer('Réinitialiser la transformation', (layer) => {
        layer.transform = {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          skewX: 0,
          skewY: 0,
          perspective: 0,
          anchorX: 0.5,
          anchorY: 0.5,
        };
      }),

    /* --------------------------------------------------------- timeline */

    setTimeline: (patch) => {
      const previous = get().project.timeline.duration;
      edit('Timeline', (project) => {
        project.timeline = { ...project.timeline, ...patch };
        project.timeline.duration = clamp(project.timeline.duration, 0.1, 600);
        project.timeline.fps = clamp(Math.round(project.timeline.fps), 1, 120);

        // Keep the animation shape when the duration changes.
        if (patch.duration !== undefined && previous > 0) {
          const factor = project.timeline.duration / previous;
          if (Math.abs(factor - 1) > 1e-6) {
            for (const layer of project.layers) {
              layer.animation.tracks = layer.animation.tracks.map((track) =>
                rescaleTrack(track, factor),
              );
            }
          }
        }
      }, { commitKey: 'timeline' });

      const { time, project } = get();
      if (time > project.timeline.duration) set({ time: project.timeline.duration });
    },

    setTime: (time) => {
      const duration = get().project.timeline.duration;
      set({ time: clamp(time, 0, duration) });
    },

    play: () => set({ playing: true }),
    pause: () => set({ playing: false }),
    togglePlay: () => set((state) => ({ playing: !state.playing })),
    stop: () => set({ playing: false, time: 0 }),
    restart: () => set({ playing: true, time: 0 }),

    stepFrame: (direction) => {
      const { time, project } = get();
      const step = 1 / project.timeline.fps;
      set({ playing: false, time: clamp(time + direction * step, 0, project.timeline.duration) });
    },

    /* -------------------------------------------------------- keyframes */

    toggleKeyframe: (property) => {
      const { time } = get();
      withActiveLayer('Keyframe', (layer) => {
        const existingIndex = layer.animation.tracks.findIndex((t) => t.property === property);
        const current = getPath(layer, property);
        if (typeof current !== 'number' && typeof current !== 'string') return;

        if (existingIndex < 0) {
          const track: Track = { property, keyframes: [] };
          layer.animation.tracks.push(upsertKeyframe(track, time, current));
          return;
        }

        const track = layer.animation.tracks[existingIndex]!;
        const atTime = track.keyframes.find((kf) => Math.abs(kf.time - time) <= 1e-4);
        const updated = atTime
          ? removeKf(track, atTime.id)
          : upsertKeyframe(track, time, current);

        if (updated.keyframes.length === 0) {
          layer.animation.tracks.splice(existingIndex, 1);
        } else {
          layer.animation.tracks[existingIndex] = updated;
        }
      });
    },

    removeKeyframe: (property, keyframeId) =>
      withActiveLayer('Supprimer un keyframe', (layer) => {
        layer.animation.tracks = layer.animation.tracks
          .map((track) => (track.property === property ? removeKf(track, keyframeId) : track))
          .filter((track) => track.keyframes.length > 0);
      }),

    moveKeyframe: (property, keyframeId, time) =>
      withActiveLayer('Déplacer un keyframe', (layer) => {
        const duration = get().project.timeline.duration;
        layer.animation.tracks = layer.animation.tracks.map((track) =>
          track.property === property ? moveKf(track, keyframeId, clamp(time, 0, duration)) : track,
        );
      }, { commitKey: `kf.move.${keyframeId}` }),

    duplicateKeyframe: (property, keyframeId) =>
      withActiveLayer('Dupliquer un keyframe', (layer) => {
        const step = Math.max(0.1, get().project.timeline.duration * 0.1);
        layer.animation.tracks = layer.animation.tracks.map((track) =>
          track.property === property ? duplicateKf(track, keyframeId, step) : track,
        );
      }),

    setKeyframeEasing: (property, keyframeId, easing) =>
      withActiveLayer('Interpolation', (layer) => {
        layer.animation.tracks = layer.animation.tracks.map((track) =>
          track.property === property ? setKfEasing(track, keyframeId, easing) : track,
        );
      }),

    removeTrack: (property) =>
      withActiveLayer('Supprimer une piste', (layer) => {
        layer.animation.tracks = layer.animation.tracks.filter((t) => t.property !== property);
      }),

    clearAnimation: () =>
      withActiveLayer('Effacer l’animation', (layer) => {
        layer.animation.tracks = [];
      }),

    applyAnimationPreset: (presetId) => {
      const { project } = get();
      withActiveLayer('Animation prédéfinie', (layer) => {
        const tracks = buildPresetTracks(presetId, layer, project.timeline);
        if (tracks.length === 0) return;
        layer.animation.tracks = mergeTracks(layer.animation.tracks, tracks);
      });
    },

    /* ----------------------------------------------------------- export */

    setExportSettings: (patch) =>
      edit('Paramètres d’export', (project) => {
        project.exportSettings = { ...project.exportSettings, ...patch };
      }, { commitKey: 'export' }),

    setExportOpen: (open) => set({ exportOpen: open }),

    /* ---------------------------------------------------------- history */

    commit: (label, key) => {
      const state = get();
      const now = Date.now();
      if (key !== undefined && key === state.lastCommitKey && now - state.lastCommitAt < COALESCE_MS) {
        return;
      }
      set({
        past: [...state.past, { project: state.project, label }].slice(-MAX_HISTORY),
        future: [],
        lastCommitKey: key ?? null,
        lastCommitAt: now,
      });
    },

    undo: () => {
      const state = get();
      const entry = state.past[state.past.length - 1];
      if (!entry) return;
      set({
        project: entry.project,
        past: state.past.slice(0, -1),
        future: [...state.future, { project: state.project, label: entry.label }],
        dirty: true,
        lastCommitKey: null,
      });
    },

    redo: () => {
      const state = get();
      const entry = state.future[state.future.length - 1];
      if (!entry) return;
      set({
        project: entry.project,
        future: state.future.slice(0, -1),
        past: [...state.past, { project: state.project, label: entry.label }],
        dirty: true,
        lastCommitKey: null,
      });
    },

    /* --------------------------------------------------------------- ui */

    setWorkspace: (workspace) => set({ workspace }),
    setTool: (tool) => set({ tool }),
    setZoom: (zoom) => set({ zoom: clamp(zoom, 0.05, 8) }),
    zoomBy: (factor) => set((state) => ({ zoom: clamp(state.zoom * factor, 0.05, 8) })),
    setPan: (panX, panY) => set({ panX, panY }),
    resetView: () => set({ zoom: 1, panX: 0, panY: 0 }),
    setReferenceImage: (dataUrl) => set({ referenceImage: dataUrl }),

    notify: (kind, message) => {
      const notification: Notification = { id: generateId('notif'), kind, message };
      set((state) => ({ notifications: [...state.notifications, notification] }));
      const delay = kind === 'error' ? 7000 : 3500;
      setTimeout(() => get().dismissNotification(notification.id), delay);
    },

    dismissNotification: (id) =>
      set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) })),
  };
});
