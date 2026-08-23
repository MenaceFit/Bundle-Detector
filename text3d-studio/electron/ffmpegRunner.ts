import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { promises as fs, createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

/**
 * Owns every ffmpeg/ffprobe child process.
 *
 * Lives in the main process: the renderer never spawns anything, it only asks
 * for named operations through the preload bridge. Long jobs are addressed by
 * id so they can report progress and be cancelled.
 */

// The Electron entry points are compiled to CommonJS, so __filename is the anchor.
const requireModule = createRequire(__filename);

export interface BinaryStatus {
  available: boolean;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  version: string | null;
  source: 'bundled' | 'system' | 'configured' | 'none';
  error?: string;
}

let cached: BinaryStatus | null = null;
let configuredPath: string | null = null;

/** A user-provided path wins over discovery, for unusual installs. */
export function setConfiguredFfmpegPath(value: string | null): void {
  configuredPath = value && value.trim().length > 0 ? value.trim() : null;
  cached = null;
}

function exists(candidate: string): Promise<boolean> {
  return fs
    .access(candidate)
    .then(() => true)
    .catch(() => false);
}

function run(binary: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout) reject(new Error(stderr || error.message));
      else resolve({ stdout, stderr });
    });
  });
}

/** Resolves `ffmpeg-static` if it is installed, without making it a hard dep. */
function bundledFfmpeg(): string | null {
  try {
    const resolved = requireModule('ffmpeg-static') as string | { path?: string } | null;
    const value = typeof resolved === 'string' ? resolved : resolved?.path;
    if (!value) return null;
    // In a packaged app the binary is unpacked next to the asar archive.
    return value.replace('app.asar', 'app.asar.unpacked');
  } catch {
    return null;
  }
}

function bundledFfprobe(): string | null {
  try {
    const resolved = requireModule('ffprobe-static') as { path?: string } | string | null;
    const value = typeof resolved === 'string' ? resolved : resolved?.path;
    if (!value) return null;
    return value.replace('app.asar', 'app.asar.unpacked');
  } catch {
    return null;
  }
}

/** Sibling ffprobe next to a known ffmpeg, which is how most installs ship. */
function siblingProbe(ffmpegPath: string): string {
  const dir = path.dirname(ffmpegPath);
  const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  return path.join(dir, name);
}

export async function detectBinaries(): Promise<BinaryStatus> {
  if (cached) return cached;

  const candidates: Array<{ ffmpeg: string; source: BinaryStatus['source'] }> = [];
  if (configuredPath) candidates.push({ ffmpeg: configuredPath, source: 'configured' });
  const bundled = bundledFfmpeg();
  if (bundled) candidates.push({ ffmpeg: bundled, source: 'bundled' });
  candidates.push({ ffmpeg: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', source: 'system' });

  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await run(candidate.ffmpeg, ['-version']);
      const version = (stdout || stderr).split('\n')[0] ?? null;

      let ffprobePath: string | null = null;
      const sibling = siblingProbe(candidate.ffmpeg);
      if (candidate.source !== 'system' && (await exists(sibling))) ffprobePath = sibling;
      if (!ffprobePath) ffprobePath = bundledFfprobe();
      if (!ffprobePath) {
        const systemProbe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
        try {
          await run(systemProbe, ['-version']);
          ffprobePath = systemProbe;
        } catch {
          ffprobePath = null;
        }
      }

      if (!ffprobePath) continue;

      cached = {
        available: true,
        ffmpegPath: candidate.ffmpeg,
        ffprobePath,
        version,
        source: candidate.source,
      };
      return cached;
    } catch {
      // Try the next candidate.
    }
  }

  cached = {
    available: false,
    ffmpegPath: null,
    ffprobePath: null,
    version: null,
    source: 'none',
    error:
      "FFmpeg est introuvable. Installez-le (ffmpeg.org) ou indiquez le chemin du binaire dans les réglages.",
  };
  return cached;
}

async function requireBinaries(): Promise<{ ffmpegPath: string; ffprobePath: string }> {
  const status = await detectBinaries();
  if (!status.available || !status.ffmpegPath || !status.ffprobePath) {
    throw new Error(status.error ?? 'FFmpeg indisponible.');
  }
  return { ffmpegPath: status.ffmpegPath, ffprobePath: status.ffprobePath };
}

export async function probe(filePath: string, args: string[]): Promise<string> {
  const { ffprobePath } = await requireBinaries();
  const { stdout } = await run(ffprobePath, args);
  return stdout;
}

export async function runFfmpeg(args: string[]): Promise<void> {
  const { ffmpegPath } = await requireBinaries();
  await run(ffmpegPath, args);
}

/* ------------------------------------------------------------- long jobs */

export interface JobHandle {
  id: string;
  /** stdout is discarded: ffmpeg writes the file itself and reports on stderr. */
  child: ChildProcessByStdio<Writable, null, Readable>;
  stderr: string;
  cancelled: boolean;
  /** Set when the frame writer must stop: ffmpeg closed stdin or we cancelled. */
  stdinClosed: boolean;
}

const jobs = new Map<string, JobHandle>();

export async function startFfmpegJob(
  id: string,
  args: string[],
  onStderr: (chunk: string) => void,
): Promise<JobHandle> {
  const { ffmpegPath } = await requireBinaries();
  const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });

  const handle: JobHandle = { id, child, stderr: '', cancelled: false, stdinClosed: false };

  // ffmpeg closes stdin as soon as it has every frame it needs — with
  // `-shortest` that happens before the last write. The resulting EPIPE is a
  // normal end of stream, so it must never surface as an export failure.
  child.stdin.on('error', () => {
    handle.stdinClosed = true;
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    handle.stderr = `${handle.stderr}${text}`.slice(-8000);
    onStderr(text);
  });

  child.on('close', () => {
    handle.stdinClosed = true;
  });

  jobs.set(id, handle);
  return handle;
}

/** Writes one frame, applying backpressure so memory does not balloon. */
export async function writeJobFrame(id: string, data: Uint8Array): Promise<boolean> {
  const handle = jobs.get(id);
  if (!handle || handle.stdinClosed || handle.cancelled) return false;

  const buffer = Buffer.from(data);
  if (handle.child.stdin.write(buffer)) return true;

  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    handle.child.stdin.once('drain', done);
    handle.child.stdin.once('error', done);
    handle.child.once('close', done);
  });
  return !handle.stdinClosed;
}

export function finishJob(id: string): Promise<{ ok: boolean; code: number | null; stderr: string }> {
  const handle = jobs.get(id);
  if (!handle) return Promise.resolve({ ok: false, code: null, stderr: 'Job inconnu.' });

  if (!handle.stdinClosed) handle.child.stdin.end();

  return new Promise((resolve) => {
    if (handle.child.exitCode !== null) {
      jobs.delete(id);
      resolve({ ok: handle.child.exitCode === 0, code: handle.child.exitCode, stderr: handle.stderr });
      return;
    }
    handle.child.once('close', (code) => {
      jobs.delete(id);
      resolve({
        ok: code === 0 && !handle.cancelled,
        code,
        stderr: handle.cancelled ? 'Annulé.' : handle.stderr,
      });
    });
  });
}

export function cancelJob(id: string): void {
  const handle = jobs.get(id);
  if (!handle) return;
  handle.cancelled = true;
  handle.stdinClosed = true;
  handle.child.kill('SIGKILL');
}

export function cancelAllJobs(): void {
  for (const id of [...jobs.keys()]) cancelJob(id);
}

/* ----------------------------------------------------------------- cache */

let cacheRoot = path.join(os.tmpdir(), 'text3d-studio-cache');

export function setCacheRoot(root: string): void {
  cacheRoot = root;
}

/** Stable per-file cache directory, so re-opening a video reuses its artefacts. */
export async function cacheDirFor(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath).catch(() => null);
  const signature = `${path.basename(filePath)}_${stat?.size ?? 0}_${Math.round(
    stat?.mtimeMs ?? 0,
  )}`;
  const safe = signature.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
  const dir = path.join(cacheRoot, safe);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function clearCache(): Promise<void> {
  await fs.rm(cacheRoot, { recursive: true, force: true });
}

/* -------------------------------------------------------------- waveform */

/**
 * Peak envelope of a 16-bit mono PCM WAV, read as a stream.
 *
 * A long video's audio is far too large to hold in memory as samples, so the
 * file is consumed chunk by chunk and reduced to `buckets` min/max pairs.
 */
export async function computeWaveform(wavPath: string, buckets: number): Promise<number[]> {
  const stat = await fs.stat(wavPath);
  // 44-byte canonical WAV header; ffmpeg writes exactly that for pcm_s16le.
  const HEADER = 44;
  const totalSamples = Math.max(1, Math.floor((stat.size - HEADER) / 2));
  const samplesPerBucket = Math.max(1, Math.floor(totalSamples / buckets));

  const peaks = new Array<number>(buckets).fill(0);
  let sampleIndex = 0;
  let carry: number | null = null;

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(wavPath, { start: HEADER });
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk;
      let offset = 0;

      // A chunk boundary can split a 16-bit sample in half.
      if (carry !== null && buffer.length > 0) {
        const value = Buffer.from([carry, buffer[0]!]).readInt16LE(0);
        accumulate(value);
        offset = 1;
        carry = null;
      }

      for (; offset + 1 < buffer.length; offset += 2) {
        accumulate(buffer.readInt16LE(offset));
      }
      if (offset < buffer.length) carry = buffer[offset]!;
    });
    stream.on('error', reject);
    stream.on('end', () => resolve());

    function accumulate(sample: number): void {
      const bucket = Math.min(buckets - 1, Math.floor(sampleIndex / samplesPerBucket));
      const magnitude = Math.abs(sample) / 32768;
      if (magnitude > peaks[bucket]!) peaks[bucket] = magnitude;
      sampleIndex += 1;
    }
  });

  return peaks;
}
