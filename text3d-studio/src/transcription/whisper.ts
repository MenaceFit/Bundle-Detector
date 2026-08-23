import type { Transcript } from '@/captions/types';
import {
  TranscriptionError,
  WHISPER_MODELS,
  type TranscriptionEngine,
  type TranscriptionRequest,
} from './types';
import { buildSegments, normalizeWords, type RawChunk } from './normalize';
import { createLogger } from '@/utils/logger';

const log = createLogger('whisper');

/**
 * Local Whisper transcription, via transformers.js.
 *
 * Everything runs on this machine: the ONNX weights are fetched once from the
 * model hub and cached by the browser/Electron, and inference happens in
 * WebAssembly (or WebGPU when the device exposes it). No audio ever leaves the
 * computer, and after the first download the feature works offline.
 *
 * `return_timestamps: 'word'` is the part that matters — it is what produces
 * per-word boundaries rather than one timestamp per sentence.
 */

type Pipeline = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text?: string; chunks?: RawChunk[] }>;

interface PipelineCacheEntry {
  modelId: string;
  pipeline: Pipeline;
}

let cached: PipelineCacheEntry | null = null;

/** Loaded lazily so the 3D workspace never pays for the ASR runtime. */
async function loadTransformers() {
  try {
    return await import('@huggingface/transformers');
  } catch (error) {
    throw new TranscriptionError(
      "Le moteur de transcription local n'a pas pu être chargé (@huggingface/transformers).",
      'loadingModel',
      error,
    );
  }
}

async function getPipeline(
  modelId: string,
  onDownload: (ratio: number | null, message: string) => void,
): Promise<Pipeline> {
  if (cached?.modelId === modelId) return cached.pipeline;

  const transformers = await loadTransformers();
  const { pipeline, env } = transformers as unknown as {
    pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<Pipeline>;
    env: { allowLocalModels?: boolean; useBrowserCache?: boolean };
  };

  // Models are cached by the runtime after the first download.
  env.useBrowserCache = true;

  try {
    const created = await pipeline('automatic-speech-recognition', modelId, {
      // q8 keeps the download small enough to be practical and runs well on CPU.
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (event: { status?: string; progress?: number; file?: string }) => {
        if (event.status === 'progress' && typeof event.progress === 'number') {
          onDownload(event.progress / 100, `Téléchargement du modèle… ${event.file ?? ''}`);
        } else if (event.status === 'ready') {
          onDownload(1, 'Modèle prêt');
        }
      },
    });
    cached = { modelId, pipeline: created };
    return created;
  } catch (error) {
    throw new TranscriptionError(
      `Le modèle « ${modelId} » n'a pas pu être chargé. Vérifiez la connexion pour le premier téléchargement, puis réessayez — il sera ensuite disponible hors ligne.`,
      'loadingModel',
      error,
    );
  }
}

export class WhisperEngine implements TranscriptionEngine {
  readonly name = 'whisper (local, transformers.js)';

  async isAvailable(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await loadTransformers();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  }

  async transcribe(request: TranscriptionRequest): Promise<Transcript> {
    const model = WHISPER_MODELS[request.tier];
    const report = request.onProgress ?? (() => {});
    const abort = (): void => {
      if (request.signal?.aborted) {
        throw new TranscriptionError('Transcription annulée.', 'transcribing');
      }
    };

    abort();
    report({ stage: 'loadingModel', ratio: 0, message: `Chargement de ${model.label}` });

    const pipe = await getPipeline(model.id, (ratio, message) => {
      report({ stage: 'loadingModel', ratio, message });
    });

    abort();
    report({
      stage: 'transcribing',
      ratio: null,
      message: 'Transcription en cours…',
    });

    const durationSec = request.audio.length / request.sampleRate;

    let output: { text?: string; chunks?: RawChunk[] };
    try {
      output = await pipe(request.audio, {
        // Word-level timestamps are the whole point; without them there is no
        // karaoke, no per-word animation and no real synchronisation.
        return_timestamps: 'word',
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(request.language === 'auto' ? {} : { language: request.language }),
        task: 'transcribe',
      });
    } catch (error) {
      throw new TranscriptionError(
        "La transcription a échoué pendant l'inférence.",
        'transcribing',
        error,
      );
    }

    abort();
    report({ stage: 'aligning', ratio: null, message: 'Alignement des mots…' });

    const chunks = output.chunks ?? [];
    if (chunks.length === 0) {
      const text = (output.text ?? '').trim();
      if (text.length === 0) {
        throw new TranscriptionError(
          "Aucune parole n'a été détectée dans cette piste audio.",
          'transcribing',
        );
      }
      // The model returned text but no timings: spread it over the duration so
      // the user still gets an editable transcript rather than nothing.
      log.warn('Transcription sans timestamps mot par mot, répartition uniforme');
      const parts = text.split(/\s+/).filter(Boolean);
      const step = durationSec / Math.max(1, parts.length);
      const words = normalizeWords(
        parts.map((part, index) => ({
          text: part,
          timestamp: [index * step, (index + 1) * step] as [number, number],
        })),
        durationSec,
      );
      return {
        language: request.language === 'auto' ? 'und' : request.language,
        words,
        segments: buildSegments(words),
        source: { engine: this.name, model: model.id },
      };
    }

    const words = normalizeWords(chunks, durationSec);
    report({ stage: 'done', ratio: 1, message: `${words.length} mots` });

    return {
      language: request.language === 'auto' ? 'und' : request.language,
      words,
      segments: buildSegments(words),
      source: { engine: this.name, model: model.id },
    };
  }
}

/**
 * Builds a transcript from text the user typed, spread evenly over a range.
 *
 * This is the manual mode, and it also serves as the fallback whenever no model
 * is available: the whole downstream pipeline — segmentation, styling,
 * animation, render, subtitle export — works identically on it.
 */
export function manualTranscript(
  text: string,
  startSec: number,
  endSec: number,
  language = 'fr',
): Transcript {
  const parts = text.split(/\s+/).filter(Boolean);
  const span = Math.max(0.1, endSec - startSec);
  const step = span / Math.max(1, parts.length);

  const words = normalizeWords(
    parts.map((part, index) => ({
      text: part,
      timestamp: [startSec + index * step, startSec + (index + 1) * step] as [number, number],
    })),
    endSec,
  );

  return {
    language,
    words,
    segments: buildSegments(words),
    source: { engine: 'manual', model: '—' },
  };
}
