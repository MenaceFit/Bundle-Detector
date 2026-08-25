import type { Transcript } from '@/captions/types';
import {
  TranscriptionError,
  WHISPER_MODELS,
  type TranscriptionEngine,
  type TranscriptionRequest,
} from './types';
import { buildSegments, normalizeWords, type RawChunk } from './normalize';
import { generateId } from '@/utils/object';
import { createLogger } from '@/utils/logger';

const log = createLogger('whisper');

/**
 * Local Whisper transcription.
 *
 * Inference runs in the main process with native ONNX Runtime, reached through
 * the preload bridge. It used to run here in WebAssembly, which could never
 * have worked: the application's Content-Security-Policy allows neither
 * `unsafe-eval` nor `wasm-unsafe-eval`, so Chromium refused to compile a single
 * WebAssembly module — every run failed before reaching the model. Moving
 * inference out also means this window keeps a strict policy and never touches
 * the network.
 *
 * What stays here is the part that has nothing to do with the runtime: turning
 * raw chunks into normalised, gap-free words. That is pure and unit-tested, and
 * it would be the same for any other engine.
 */

function bridge() {
  const asr = window.desktop?.asr;
  if (!asr) {
    throw new TranscriptionError(
      'La transcription locale nécessite l’application de bureau : le navigateur ne peut pas exécuter le modèle.',
      'loadingModel',
    );
  }
  return asr;
}

export function isTranscriptionAvailable(): boolean {
  return Boolean(window.desktop?.asr);
}

export class WhisperEngine implements TranscriptionEngine {
  readonly name = 'whisper (local, ONNX Runtime natif)';

  async isAvailable(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const status = await bridge().status();
      return status.available
        ? { ok: true }
        : { ok: false, reason: status.error ?? 'Moteur indisponible.' };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  }

  async transcribe(request: TranscriptionRequest): Promise<Transcript> {
    const model = WHISPER_MODELS[request.tier];
    const report = request.onProgress ?? (() => {});
    const asr = bridge();
    const id = generateId('asr');
    const durationSec = request.audio.length / request.sampleRate;

    report({ stage: 'loadingModel', ratio: 0, message: `Chargement de ${model.label}` });

    // Progress arrives as events while the invoke is still pending.
    const stopListening = asr.onProgress((progress) => {
      if (progress.id !== id) return;
      report({ stage: progress.stage, ratio: progress.ratio, message: progress.message });
    });

    const onAbort = (): void => {
      void asr.cancel(id);
    };
    request.signal?.addEventListener('abort', onAbort);

    let result: Awaited<ReturnType<typeof asr.run>>;
    try {
      result = await asr.run({
        id,
        // The samples are transferred, not copied through JSON.
        audio: toTransferable(request.audio),
        modelId: model.id,
        language: request.language === 'auto' ? null : request.language,
        durationSec,
      });
    } catch (error) {
      throw new TranscriptionError(
        'La transcription a échoué pendant l’inférence.',
        'transcribing',
        error,
      );
    } finally {
      stopListening();
      request.signal?.removeEventListener('abort', onAbort);
    }

    if (!result.ok) {
      if (result.cancelled) {
        throw new TranscriptionError('Transcription annulée.', 'transcribing');
      }
      throw new TranscriptionError(describeFailure(result.message, model.id), 'loadingModel');
    }

    report({ stage: 'aligning', ratio: null, message: 'Alignement des mots…' });

    const chunks = result.chunks as RawChunk[];
    if (chunks.length === 0) {
      const text = result.text.trim();
      if (text.length === 0) {
        throw new TranscriptionError(
          'Aucune parole n’a été détectée dans cette piste audio.',
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

/** A view into a larger buffer cannot be sent as-is; give IPC its own copy. */
function toTransferable(samples: Float32Array): ArrayBuffer {
  if (samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength) {
    return samples.buffer as ArrayBuffer;
  }
  return samples.slice().buffer as ArrayBuffer;
}

/**
 * Turns a runtime failure into something the user can act on.
 *
 * The first run has to download the weights, and that is the only moment the
 * feature ever needs the network — so anything that smells like a transfer
 * problem says so plainly instead of surfacing a raw fetch error. Observed
 * messages include Node network codes, HTTP statuses, and the runtime's own
 * `Forbidden access to file: "https://…"`, which is what a company proxy or a
 * firewall produces.
 */
export function describeFailure(message: string, modelId: string): string {
  const lower = message.toLowerCase();
  const mentionsDownload =
    lower.includes('http://') ||
    lower.includes('https://') ||
    lower.includes('access to file') ||
    lower.includes('huggingface');

  const networkish =
    lower.includes('fetch') ||
    lower.includes('network') ||
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('getaddrinfo') ||
    lower.includes('certificate') ||
    lower.includes('self-signed') ||
    lower.includes('proxy') ||
    lower.includes('forbidden') ||
    lower.includes('unauthorized') ||
    lower.includes('403') ||
    lower.includes('502') ||
    lower.includes('503');

  if (lower.includes('enospc') || lower.includes('no space left')) {
    return `Espace disque insuffisant pour installer « ${modelId} ». Détail : ${message}`;
  }
  if (mentionsDownload && (lower.includes('404') || lower.includes('not found'))) {
    return `Le modèle « ${modelId} » est introuvable sur le dépôt. Détail : ${message}`;
  }
  if (mentionsDownload || networkish) {
    return (
      `Le modèle « ${modelId} » n’a pas pu être téléchargé. C’est le seul moment où ` +
      'l’application a besoin d’Internet : une fois les fichiers récupérés, la transcription ' +
      'fonctionne hors ligne. Vérifiez la connexion, un pare-feu ou un proxy d’entreprise, ' +
      `puis réessayez. Détail : ${message}`
    );
  }
  return `Le modèle « ${modelId} » n’a pas pu être chargé. Détail : ${message}`;
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
