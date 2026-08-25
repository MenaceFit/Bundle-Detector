import { create } from 'zustand';
import type {
  CaptionAnimation,
  CaptionCue,
  CaptionStyle,
  CaptionTrack,
  SegmentationOptions,
  Transcript,
  VideoMetadata,
  WordTimestamp,
} from '@/captions/types';
import {
  BUILTIN_CAPTION_PRESETS,
  cloneCaptionStyle,
  DEFAULT_CAPTION_ANIMATION,
  DEFAULT_CAPTION_STYLE,
  findCaptionPreset,
} from '@/captions/presets';
import { buildCaptionTrack, DEFAULT_SEGMENTATION, refreshCue, segmentWords } from '@/captions/segmentation';
import { applyEmphasis, suggestEmphasis } from '@/transcription/normalize';
import type { ModelTier, TranscriptionProgress } from '@/transcription/types';
import type { FitMode } from '@/ffmpeg';
import { generateId } from '@/utils/object';
import { clamp } from '@/utils/math';

/**
 * State of the Video Captions workspace.
 *
 * Deliberately separate from the 3D document store: the two workspaces share
 * the rendering and animation engines, not their state. Nothing here mutates
 * the source video — the project is a description of what to draw over it.
 */

export type CaptionStep = 'import' | 'transcript' | 'style' | 'export';

export interface JobState {
  running: boolean;
  label: string;
  ratio: number | null;
  error: string | null;
}

const IDLE: JobState = { running: false, label: '', ratio: null, error: null };

export interface OutputSettings {
  width: number;
  height: number;
  fps: number;
  fit: FitMode;
  quality: 'social' | 'high' | 'maximum' | 'small';
}

/**
 * What the preview player is currently able to show.
 *
 * `source` distinguishes the original file from the cached H.264 proxy built
 * for sources the browser engine cannot decode; `status` drives the banner over
 * the stage so a conversion is never a silent wait.
 */
export interface PreviewState {
  path: string | null;
  source: 'original' | 'proxy';
  status: 'idle' | 'preparing' | 'ready' | 'error';
  message: string;
}

const PREVIEW_IDLE: PreviewState = {
  path: null,
  source: 'original',
  status: 'idle',
  message: '',
};

export interface VideoCaptionsState {
  step: CaptionStep;
  metadata: VideoMetadata | null;
  thumbnailUrl: string | null;
  audioPath: string | null;
  waveform: number[];

  transcript: Transcript | null;
  track: CaptionTrack;
  segmentation: SegmentationOptions;

  style: CaptionStyle;
  animation: CaptionAnimation;
  presetId: string;

  language: string;
  tier: ModelTier;

  output: OutputSettings;
  showSafeZones: boolean;

  time: number;
  playing: boolean;
  selectedWordId: string | null;
  preview: PreviewState;

  transcription: JobState;
  exportJob: JobState;

  setStep: (step: CaptionStep) => void;
  setVideo: (metadata: VideoMetadata, thumbnailUrl: string | null) => void;
  clearVideo: () => void;
  setAudio: (path: string, waveform: number[]) => void;

  setTranscript: (transcript: Transcript) => void;
  resegment: (patch?: Partial<SegmentationOptions>) => void;
  editWordText: (wordId: string, text: string) => void;
  editWordTiming: (wordId: string, start: number, end: number) => void;
  toggleWordEmphasis: (wordId: string) => void;
  removeWord: (wordId: string) => void;
  splitCueAt: (wordId: string) => void;
  mergeCueWithNext: (cueId: string) => void;
  autoHighlight: () => void;
  clearEmphasis: () => void;

  applyPreset: (presetId: string) => void;
  patchStyle: (patch: Partial<CaptionStyle>) => void;
  patchStylePath: (path: string, value: unknown) => void;
  patchAnimation: (patch: Partial<CaptionAnimation>) => void;

  setLanguage: (language: string) => void;
  setTier: (tier: ModelTier) => void;
  setOutput: (patch: Partial<OutputSettings>) => void;
  toggleSafeZones: () => void;

  setTime: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  selectWord: (wordId: string | null) => void;
  setPreview: (patch: Partial<PreviewState>) => void;

  setTranscription: (patch: Partial<JobState>) => void;
  reportTranscription: (progress: TranscriptionProgress) => void;
  setExportJob: (patch: Partial<JobState>) => void;

  hydrate: (snapshot: VideoProjectSnapshot) => void;
}

/** What a `.video-project.json` carries. */
export interface VideoProjectSnapshot {
  version: 1;
  videoPath: string | null;
  metadata: VideoMetadata | null;
  transcript: Transcript | null;
  track: CaptionTrack;
  segmentation: SegmentationOptions;
  style: CaptionStyle;
  animation: CaptionAnimation;
  presetId: string;
  language: string;
  tier: ModelTier;
  output: OutputSettings;
}

const DEFAULT_OUTPUT: OutputSettings = {
  width: 1080,
  height: 1920,
  fps: 30,
  fit: 'crop',
  quality: 'high',
};

/** Rebuilds the cue list from the transcript's current words. */
function rebuild(transcript: Transcript | null, options: SegmentationOptions): CaptionTrack {
  if (!transcript) return { cues: [] };
  return buildCaptionTrack(transcript, options);
}

export const useVideoStore = create<VideoCaptionsState>((set, get) => ({
  step: 'import',
  metadata: null,
  thumbnailUrl: null,
  audioPath: null,
  waveform: [],

  transcript: null,
  track: { cues: [] },
  segmentation: { ...DEFAULT_SEGMENTATION },

  style: cloneCaptionStyle(DEFAULT_CAPTION_STYLE),
  animation: { ...DEFAULT_CAPTION_ANIMATION },
  presetId: BUILTIN_CAPTION_PRESETS[0]?.id ?? 'classic',

  language: 'auto',
  tier: 'balanced',

  output: { ...DEFAULT_OUTPUT },
  showSafeZones: false,

  time: 0,
  playing: false,
  selectedWordId: null,
  preview: { ...PREVIEW_IDLE },

  transcription: { ...IDLE },
  exportJob: { ...IDLE },

  setStep: (step) => set({ step }),

  setVideo: (metadata, thumbnailUrl) =>
    set((state) => ({
      metadata,
      thumbnailUrl,
      audioPath: null,
      waveform: [],
      time: 0,
      playing: false,
      // The new file has to be checked for playability before it can be shown.
      preview: { ...PREVIEW_IDLE },
      step: 'transcript',
      // A vertical source keeps its own frame; a landscape one defaults to 9:16.
      output: {
        ...state.output,
        width: metadata.height > metadata.width ? metadata.width : DEFAULT_OUTPUT.width,
        height: metadata.height > metadata.width ? metadata.height : DEFAULT_OUTPUT.height,
        fps: metadata.fps > 0 ? Math.min(60, Math.round(metadata.fps)) : 30,
      },
    })),

  clearVideo: () =>
    set({
      metadata: null,
      thumbnailUrl: null,
      audioPath: null,
      waveform: [],
      transcript: null,
      track: { cues: [] },
      time: 0,
      playing: false,
      preview: { ...PREVIEW_IDLE },
      step: 'import',
      selectedWordId: null,
      transcription: { ...IDLE },
      exportJob: { ...IDLE },
    }),

  setAudio: (path, waveform) => set({ audioPath: path, waveform }),

  setPreview: (patch) => set((state) => ({ preview: { ...state.preview, ...patch } })),

  setTranscript: (transcript) =>
    set((state) => ({
      transcript,
      track: rebuild(transcript, state.segmentation),
      step: 'style',
      transcription: { ...IDLE },
    })),

  resegment: (patch) =>
    set((state) => {
      const segmentation = { ...state.segmentation, ...(patch ?? {}) };
      return { segmentation, track: rebuild(state.transcript, segmentation) };
    }),

  editWordText: (wordId, text) =>
    set((state) => {
      if (!state.transcript) return {};
      const words = state.transcript.words.map((word) =>
        word.id === wordId ? { ...word, text } : word,
      );
      const transcript = { ...state.transcript, words };
      // Editing text must never move a timing: patch the cue in place.
      const track = {
        cues: state.track.cues.map((cue) =>
          cue.words.some((word) => word.id === wordId)
            ? refreshCue({ ...cue, words: cue.words.map((w) => (w.id === wordId ? { ...w, text } : w)) })
            : cue,
        ),
      };
      return { transcript, track };
    }),

  editWordTiming: (wordId, start, end) =>
    set((state) => {
      if (!state.transcript) return {};
      const safeEnd = Math.max(end, start + 0.03);
      const apply = (word: WordTimestamp): WordTimestamp =>
        word.id === wordId ? { ...word, start, end: safeEnd } : word;
      const transcript = { ...state.transcript, words: state.transcript.words.map(apply) };
      const track = {
        cues: state.track.cues.map((cue) =>
          cue.words.some((word) => word.id === wordId)
            ? refreshCue({ ...cue, words: cue.words.map(apply) })
            : cue,
        ),
      };
      return { transcript, track };
    }),

  toggleWordEmphasis: (wordId) =>
    set((state) => {
      if (!state.transcript) return {};
      const flip = (word: WordTimestamp): WordTimestamp =>
        word.id === wordId ? { ...word, emphasis: !word.emphasis } : word;
      return {
        transcript: { ...state.transcript, words: state.transcript.words.map(flip) },
        track: { cues: state.track.cues.map((cue) => ({ ...cue, words: cue.words.map(flip) })) },
      };
    }),

  removeWord: (wordId) =>
    set((state) => {
      if (!state.transcript) return {};
      const words = state.transcript.words.filter((word) => word.id !== wordId);
      const transcript = { ...state.transcript, words };
      return { transcript, track: rebuild(transcript, state.segmentation), selectedWordId: null };
    }),

  /** Breaks a cue in two, starting a new one at the given word. */
  splitCueAt: (wordId) =>
    set((state) => {
      const cues: CaptionCue[] = [];
      for (const cue of state.track.cues) {
        const index = cue.words.findIndex((word) => word.id === wordId);
        if (index <= 0) {
          cues.push(cue);
          continue;
        }
        cues.push(refreshCue({ ...cue, id: generateId('cue'), words: cue.words.slice(0, index) }));
        cues.push(refreshCue({ ...cue, id: generateId('cue'), words: cue.words.slice(index) }));
      }
      return { track: { cues } };
    }),

  mergeCueWithNext: (cueId) =>
    set((state) => {
      const index = state.track.cues.findIndex((cue) => cue.id === cueId);
      const current = state.track.cues[index];
      const next = state.track.cues[index + 1];
      if (!current || !next) return {};
      const merged = refreshCue({ ...current, words: [...current.words, ...next.words] });
      const cues = [...state.track.cues];
      cues.splice(index, 2, merged);
      return { track: { cues } };
    }),

  autoHighlight: () =>
    set((state) => {
      if (!state.transcript) return {};
      const ids = suggestEmphasis(state.transcript.words);
      const words = applyEmphasis(state.transcript.words, ids);
      const transcript = { ...state.transcript, words };
      return { transcript, track: rebuild(transcript, state.segmentation) };
    }),

  clearEmphasis: () =>
    set((state) => {
      if (!state.transcript) return {};
      const words = state.transcript.words.map((word) => ({ ...word, emphasis: false }));
      const transcript = { ...state.transcript, words };
      return { transcript, track: rebuild(transcript, state.segmentation) };
    }),

  applyPreset: (presetId) => {
    const preset = findCaptionPreset(presetId);
    if (!preset) return;
    set({
      presetId,
      style: cloneCaptionStyle(preset.style),
      animation: { ...preset.animation },
    });
  },

  patchStyle: (patch) => set((state) => ({ style: { ...state.style, ...patch } })),

  /** Dotted-path setter, so the property panels stay declarative. */
  patchStylePath: (path, value) =>
    set((state) => {
      const style = cloneCaptionStyle(state.style);
      const segments = path.split('.');
      let target = style as unknown as Record<string, unknown>;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const key = segments[i]!;
        const next = target[key];
        if (next === null || typeof next !== 'object') return {};
        target = next as Record<string, unknown>;
      }
      target[segments[segments.length - 1]!] = value;
      return { style };
    }),

  patchAnimation: (patch) => set((state) => ({ animation: { ...state.animation, ...patch } })),

  setLanguage: (language) => set({ language }),
  setTier: (tier) => set({ tier }),
  setOutput: (patch) => set((state) => ({ output: { ...state.output, ...patch } })),
  toggleSafeZones: () => set((state) => ({ showSafeZones: !state.showSafeZones })),

  setTime: (time) => {
    const duration = get().metadata?.durationSec ?? 0;
    set({ time: clamp(time, 0, Math.max(0, duration)) });
  },
  setPlaying: (playing) => set({ playing }),
  selectWord: (selectedWordId) => set({ selectedWordId }),

  setTranscription: (patch) =>
    set((state) => ({ transcription: { ...state.transcription, ...patch } })),

  reportTranscription: (progress) =>
    set((state) => ({
      transcription: {
        ...state.transcription,
        running: progress.stage !== 'done',
        label: progress.message,
        ratio: progress.ratio,
      },
    })),

  setExportJob: (patch) => set((state) => ({ exportJob: { ...state.exportJob, ...patch } })),

  hydrate: (snapshot) =>
    set({
      metadata: snapshot.metadata,
      transcript: snapshot.transcript,
      track: snapshot.track,
      segmentation: snapshot.segmentation,
      style: snapshot.style,
      animation: snapshot.animation,
      presetId: snapshot.presetId,
      language: snapshot.language,
      tier: snapshot.tier,
      output: snapshot.output,
      step: snapshot.transcript ? 'style' : 'import',
      time: 0,
      playing: false,
      // A reopened project re-checks the source: the machine may differ.
      preview: { ...PREVIEW_IDLE },
    }),
}));

/** Words re-segmented on demand, without touching the store. */
export function previewSegmentation(
  words: WordTimestamp[],
  options: SegmentationOptions,
): CaptionTrack {
  return { cues: segmentWords(words, options) };
}
