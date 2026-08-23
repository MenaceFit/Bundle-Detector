import type { Transcript } from '@/captions/types';

/**
 * Transcription is kept behind an interface on purpose.
 *
 * The rest of the pipeline only ever sees `Transcript` — words with timings —
 * so the ASR implementation can be swapped (a different Whisper build, a local
 * server, a hand-written transcript) without touching segmentation, styling,
 * rendering or export.
 */

export type ModelTier = 'fast' | 'balanced' | 'accurate';

export interface ModelDescriptor {
  tier: ModelTier;
  /** Repository id of the ONNX model. */
  id: string;
  label: string;
  /** Approximate download size, shown before the first use. */
  downloadMb: number;
  /** Rough speed relative to real time on a modern CPU, for the estimate. */
  realtimeFactor: number;
}

export const WHISPER_MODELS: Record<ModelTier, ModelDescriptor> = {
  fast: {
    tier: 'fast',
    id: 'onnx-community/whisper-tiny',
    label: 'Fast — whisper tiny',
    downloadMb: 75,
    realtimeFactor: 0.15,
  },
  balanced: {
    tier: 'balanced',
    id: 'onnx-community/whisper-base',
    label: 'Balanced — whisper base',
    downloadMb: 145,
    realtimeFactor: 0.3,
  },
  accurate: {
    tier: 'accurate',
    id: 'onnx-community/whisper-small',
    label: 'Accurate — whisper small',
    downloadMb: 480,
    realtimeFactor: 0.9,
  },
};

export type TranscriptionStage =
  | 'preparing'
  | 'loadingModel'
  | 'detectingLanguage'
  | 'transcribing'
  | 'aligning'
  | 'done';

export interface TranscriptionProgress {
  stage: TranscriptionStage;
  /** 0..1 within the current stage, or null when it cannot be measured. */
  ratio: number | null;
  message: string;
}

export interface TranscriptionRequest {
  /** 16 kHz mono samples in the -1..1 range. */
  audio: Float32Array;
  sampleRate: number;
  /** ISO code, or 'auto' to let the model decide. */
  language: string | 'auto';
  tier: ModelTier;
  onProgress?: (progress: TranscriptionProgress) => void;
  signal?: AbortSignal;
}

export interface TranscriptionEngine {
  readonly name: string;
  /** Whether the engine can run here — models present, runtime available. */
  isAvailable(): Promise<{ ok: boolean; reason?: string }>;
  transcribe(request: TranscriptionRequest): Promise<Transcript>;
}

export class TranscriptionError extends Error {
  constructor(
    message: string,
    /** Which part failed, so the UI can say what to retry. */
    readonly stage: TranscriptionStage,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

export const SUPPORTED_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'auto', label: 'Détection automatique' },
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'ar', label: 'العربية' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' },
  { code: 'ru', label: 'Русский' },
];

export function languageLabel(code: string): string {
  return SUPPORTED_LANGUAGES.find((entry) => entry.code === code)?.label ?? code.toUpperCase();
}

/** Rough processing estimate, shown before a run starts. */
export function estimateProcessingSec(durationSec: number, tier: ModelTier): number {
  return Math.max(2, durationSec * WHISPER_MODELS[tier].realtimeFactor);
}
