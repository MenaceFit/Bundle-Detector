import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Local Whisper transcription, running in the main process.
 *
 * It used to run in the renderer through WebAssembly, and it could never have
 * worked there: the application's own Content-Security-Policy allows neither
 * `unsafe-eval` nor `wasm-unsafe-eval`, so Chromium refused to compile a single
 * WebAssembly module. Relaxing the CSP would have traded a security guarantee
 * for a slow single-threaded runtime — the window is not cross-origin isolated,
 * so `SharedArrayBuffer` is absent and the threaded build cannot use threads.
 *
 * Here, ONNX Runtime runs natively with real threads, the model download has no
 * CSP to satisfy, and the renderer keeps a strict policy and never reaches the
 * network at all. The audio arrives as raw samples over IPC and never leaves
 * the machine.
 */

// The Electron entry points are compiled to CommonJS, so __filename is the anchor.
const requireModule = createRequire(__filename);

export interface RawChunk {
  text: string;
  timestamp: [number, number | null];
}

export interface TranscriberProgress {
  stage: 'loadingModel' | 'transcribing';
  ratio: number | null;
  message: string;
}

export interface TranscriptionResult {
  chunks: RawChunk[];
  text: string;
}

export class TranscriptionCancelled extends Error {
  constructor() {
    super('Transcription annulée.');
    this.name = 'TranscriptionCancelled';
  }
}

interface Transformers {
  pipeline: (
    task: string,
    model: string,
    options: Record<string, unknown>,
  ) => Promise<TranscribePipeline>;
  env: Record<string, unknown>;
  WhisperTextStreamer: new (tokenizer: unknown, options: Record<string, unknown>) => unknown;
  InterruptableStoppingCriteria: new () => { interrupt: () => void };
}

type TranscribePipeline = ((
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text?: string; chunks?: RawChunk[] }>) & { tokenizer: unknown };

let transformers: Transformers | null = null;
let cacheDir: string | null = null;

/** Where the downloaded weights live, so a second run is fully offline. */
export function setModelCacheDir(dir: string): void {
  cacheDir = dir;
  if (transformers) transformers.env['cacheDir'] = dir;
}

export function modelCacheDir(): string | null {
  return cacheDir;
}

function loadTransformers(): Transformers {
  if (transformers) return transformers;
  const loaded = requireModule('@huggingface/transformers') as Transformers;
  // Weights are fetched once and then read from disk.
  loaded.env['allowRemoteModels'] = true;
  loaded.env['useFSCache'] = true;
  if (cacheDir) loaded.env['cacheDir'] = cacheDir;
  transformers = loaded;
  return loaded;
}

/** Whether the runtime is present and loadable on this machine. */
export function transcriberStatus(): { available: boolean; error?: string; cacheDir?: string } {
  try {
    loadTransformers();
    return { available: true, ...(cacheDir ? { cacheDir } : {}) };
  } catch (error) {
    return { available: false, error: (error as Error).message };
  }
}

interface CachedPipeline {
  modelId: string;
  pipe: TranscribePipeline;
}

let cachedPipeline: CachedPipeline | null = null;

/**
 * Aggregates the per-file download events into a single ratio.
 *
 * A Whisper repository is several files of very different sizes, so reporting
 * each file's own percentage makes the bar jump backwards; the totals are
 * summed instead.
 */
function downloadReporter(report: (progress: TranscriberProgress) => void) {
  const files = new Map<string, { loaded: number; total: number }>();

  return (event: {
    status?: string;
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
  }): void => {
    if (event.status === 'progress' && event.file) {
      files.set(event.file, {
        loaded: event.loaded ?? 0,
        total: event.total ?? 0,
      });
      let loaded = 0;
      let total = 0;
      for (const entry of files.values()) {
        loaded += entry.loaded;
        total += entry.total;
      }
      const ratio = total > 0 ? Math.min(1, loaded / total) : null;
      report({
        stage: 'loadingModel',
        ratio,
        message:
          total > 0
            ? `Téléchargement du modèle — ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} Mo`
            : 'Téléchargement du modèle…',
      });
    } else if (event.status === 'ready') {
      report({ stage: 'loadingModel', ratio: 1, message: 'Modèle prêt' });
    }
  };
}

async function getPipeline(
  modelId: string,
  report: (progress: TranscriberProgress) => void,
): Promise<TranscribePipeline> {
  if (cachedPipeline?.modelId === modelId) return cachedPipeline.pipe;

  const { pipeline } = loadTransformers();
  const pipe = await pipeline('automatic-speech-recognition', modelId, {
    // q8 weights: a quarter of the download, and the accuracy loss on speech is
    // not audible in a caption.
    dtype: 'q8',
    device: 'cpu',
    progress_callback: downloadReporter(report),
  });
  cachedPipeline = { modelId, pipe };
  return pipe;
}

/** Jobs currently running, so they can be interrupted from another IPC call. */
const running = new Map<string, { cancel: () => void }>();

export function cancelTranscription(id: string): boolean {
  const job = running.get(id);
  if (!job) return false;
  job.cancel();
  return true;
}

export async function transcribe(options: {
  id: string;
  audio: Float32Array;
  modelId: string;
  /** ISO code, or null to let the model detect it. */
  language: string | null;
  durationSec: number;
  onProgress: (progress: TranscriberProgress) => void;
}): Promise<TranscriptionResult> {
  const { InterruptableStoppingCriteria, WhisperTextStreamer } = loadTransformers();

  const stopper = new InterruptableStoppingCriteria();
  let cancelled = false;

  // Registered before the model loads: the first run downloads several hundred
  // megabytes, and Cancel has to work during that, not only during inference.
  running.set(options.id, {
    cancel: () => {
      cancelled = true;
      // Generation stops at the next token; the remaining windows then return
      // immediately, and the result is discarded below.
      stopper.interrupt();
    },
  });

  const abortIfCancelled = (): void => {
    if (cancelled) throw new TranscriptionCancelled();
  };

  try {
    options.onProgress({ stage: 'loadingModel', ratio: null, message: 'Chargement du modèle…' });
    const pipe = await getPipeline(options.modelId, (progress) => {
      // Throwing out of the download callback is what interrupts the transfer.
      abortIfCancelled();
      options.onProgress(progress);
    });
    abortIfCancelled();

    // Whisper reads the audio in windows; the start of each one is the only
    // honest progress signal there is.
    const streamer = new WhisperTextStreamer(pipe.tokenizer, {
      on_chunk_start: (offsetSec: number) => {
        const ratio =
          options.durationSec > 0 ? Math.min(1, offsetSec / options.durationSec) : null;
        options.onProgress({
          stage: 'transcribing',
          ratio,
          message: `Transcription — ${formatClock(offsetSec)} / ${formatClock(options.durationSec)}`,
        });
      },
    });

    const output = await pipe(options.audio, {
      // Word-level timestamps are the whole point: without them there is no
      // karaoke, no per-word animation and no real synchronisation.
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      ...(options.language ? { language: options.language } : {}),
      streamer,
      stopping_criteria: stopper,
    });

    abortIfCancelled();
    return { chunks: output.chunks ?? [], text: (output.text ?? '').trim() };
  } finally {
    running.delete(options.id);
  }
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/** Deletes the downloaded weights. */
export async function clearModelCache(): Promise<void> {
  if (!cacheDir) return;
  const { promises: fs } = requireModule('node:fs') as typeof import('node:fs');
  await fs.rm(cacheDir, { recursive: true, force: true });
  await fs.mkdir(cacheDir, { recursive: true });
  cachedPipeline = null;
}

export function defaultCacheDir(userDataPath: string): string {
  return path.join(userDataPath, 'whisper-models');
}
