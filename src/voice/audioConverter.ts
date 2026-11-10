/**
 * Server-side fallback conversion of browser recordings (WebM/Matroska or MP4)
 * to 16 kHz mono 16-bit little-endian PCM (Requirement 14.5).
 *
 * Security constraints (Requirement 14.10):
 * - The ffmpeg argument list is fixed. Only the demuxer (chosen from the detected
 *   container) and a server-generated input path vary; no request value reaches it.
 * - The process is spawned with `shell: false` and an empty environment.
 * - `-protocol_whitelist file,pipe` and the mov demuxer's default `enable_drefs=0`
 *   stop media files from referencing network or other local resources.
 * - Input is written to a 0600 file in a fresh `mkdtemp` directory (non-fragmented
 *   MP4 often keeps its `moov` atom at the end, so it cannot be read from a pipe).
 *   The directory is removed on every path.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_AUDIO_BYTES, type AudioContainer } from './audio.js';

/** The container detected by `classifyContentType` / `validateIncomingAudio`. */
export type ConvertibleContainer = AudioContainer;

export type ConversionFailureReason = 'failed' | 'too_large' | 'timeout';

export type ConversionResult =
  | { ok: true; pcm: Uint8Array } // 16 kHz mono s16le, even length, <= maxOutputBytes
  | { ok: false; reason: ConversionFailureReason };

export interface ConversionInput {
  bytes: Uint8Array;
  container: ConvertibleContainer;
}

export interface ConversionOptions {
  signal: AbortSignal;
  maxOutputBytes: number;
}

export interface AudioConverter {
  convert(input: ConversionInput, options: ConversionOptions): Promise<ConversionResult>;
}

const DEMUXER: Readonly<Record<ConvertibleContainer, 'matroska' | 'mov'>> = {
  webm: 'matroska',
  mp4: 'mov',
};

/** The fixed ffmpeg argument list. Only the demuxer and `inputPath` vary. */
export function ffmpegArgs(container: ConvertibleContainer, inputPath: string): readonly string[] {
  const demuxer = DEMUXER[container];
  if (demuxer === undefined) {
    throw new Error('Unsupported container');
  }
  return Object.freeze([
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-threads',
    '1',
    '-f',
    demuxer,
    '-i',
    inputPath,
    '-vn',
    '-map_metadata',
    '-1',
    '-t',
    '31',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-f',
    's16le',
    'pipe:1',
  ]);
}

// ---------------------------------------------------------------------------
// Process runner abstraction (injectable for tests)
// ---------------------------------------------------------------------------

export interface ProcessRunOptions {
  shell: false;
  env: Record<string, string>;
  stdio: readonly ['ignore', 'pipe', 'pipe'];
  onStdout: (chunk: Uint8Array) => void;
  onStderr: (chunk: Uint8Array) => void;
}

export interface ProcessExit {
  /** Exit code, or null when the process was killed by a signal or failed to start. */
  code: number | null;
  signal: string | null;
  /** Set when the process could not be started (e.g. binary missing). */
  error?: Error;
}

export interface RunningProcess {
  kill(signal: 'SIGKILL'): void;
  readonly exited: Promise<ProcessExit>;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], options: ProcessRunOptions): RunningProcess;
}

/** Real runner over `node:child_process.spawn`. */
export const nodeProcessRunner: ProcessRunner = {
  run(command, args, options) {
    const child = spawn(command, [...args], {
      shell: options.shell,
      env: options.env,
      stdio: [...options.stdio],
    });
    child.stdout?.on('data', (chunk: Buffer) => options.onStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => options.onStderr(chunk));
    const exited = new Promise<ProcessExit>((resolve) => {
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        resolve({ code: null, signal: null, error });
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        resolve({ code, signal });
      });
    });
    return {
      kill(signal) {
        child.kill(signal);
      },
      exited,
    };
  },
};

// ---------------------------------------------------------------------------
// ffmpeg converter
// ---------------------------------------------------------------------------

export const MAX_STDERR_BYTES = 4 * 1024;
export const DEFAULT_CONVERSION_TIMEOUT_MS = 5_000;

export interface FfmpegAudioConverterOptions {
  ffmpegPath: string;
  runner?: ProcessRunner;
  /** Parent directory for the per-request temp directory. Defaults to `os.tmpdir()`. */
  tmpRoot?: string;
  /** Hard cap on process runtime, applied in addition to the caller's signal. */
  timeoutMs?: number;
  /** Receives a sanitized, truncated stderr line on failure. Never receives audio bytes. */
  log?: (entry: { event: 'audio_conversion_failed'; reason: ConversionFailureReason; exitCode: number | null; stderr: string }) => void;
}

export class FfmpegAudioConverter implements AudioConverter {
  private readonly ffmpegPath: string;
  private readonly runner: ProcessRunner;
  private readonly tmpRoot: string;
  private readonly timeoutMs: number;
  private readonly log: FfmpegAudioConverterOptions['log'];

  constructor(options: FfmpegAudioConverterOptions) {
    this.ffmpegPath = options.ffmpegPath;
    this.runner = options.runner ?? nodeProcessRunner;
    this.tmpRoot = options.tmpRoot ?? tmpdir();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONVERSION_TIMEOUT_MS;
    this.log = options.log;
  }

  async convert(input: ConversionInput, options: ConversionOptions): Promise<ConversionResult> {
    if (options.signal.aborted) {
      return { ok: false, reason: 'timeout' };
    }
    const maxOutputBytes = Math.max(0, Math.min(options.maxOutputBytes, MAX_AUDIO_BYTES));
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(this.tmpRoot, 'sous-audio-'));
      const inputPath = join(dir, input.container === 'webm' ? 'input.webm' : 'input.mp4');
      await writeFile(inputPath, input.bytes, { mode: 0o600 });
      if (options.signal.aborted) {
        return { ok: false, reason: 'timeout' };
      }
      return await this.runFfmpeg(ffmpegArgs(input.container, inputPath), options.signal, maxOutputBytes);
    } catch {
      return this.fail('failed', null, '');
    } finally {
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async runFfmpeg(
    args: readonly string[],
    signal: AbortSignal,
    maxOutputBytes: number,
  ): Promise<ConversionResult> {
    const chunks: Uint8Array[] = [];
    let outputBytes = 0;
    let stderr = '';
    let stderrBytes = 0;
    let killedFor: 'too_large' | 'timeout' | undefined;

    let proc: RunningProcess | undefined;
    const kill = (reason: 'too_large' | 'timeout'): void => {
      if (killedFor !== undefined) return;
      killedFor = reason;
      proc?.kill('SIGKILL');
    };

    proc = this.runner.run(this.ffmpegPath, args, {
      shell: false,
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
      onStdout: (chunk) => {
        if (killedFor !== undefined) return;
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          chunks.length = 0;
          kill('too_large');
          return;
        }
        chunks.push(chunk);
      },
      onStderr: (chunk) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return;
        const take = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
        stderrBytes += take.length;
        stderr += Buffer.from(take).toString('utf8');
      },
    });

    // A runner may emit output synchronously before `proc` is assigned.
    if (killedFor !== undefined) proc.kill('SIGKILL');

    const onAbort = (): void => kill('timeout');
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => kill('timeout'), this.timeoutMs);
    if (signal.aborted) onAbort();

    let exit: ProcessExit;
    try {
      exit = await proc.exited;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }

    if (killedFor !== undefined) {
      return this.fail(killedFor, exit.code, stderr);
    }
    if (exit.error !== undefined || exit.code !== 0) {
      return this.fail('failed', exit.code, stderr);
    }
    if (outputBytes === 0 || outputBytes % 2 !== 0) {
      return this.fail('failed', exit.code, stderr);
    }
    const pcm = new Uint8Array(outputBytes);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    return { ok: true, pcm };
  }

  private fail(reason: ConversionFailureReason, exitCode: number | null, stderr: string): ConversionResult {
    this.log?.({ event: 'audio_conversion_failed', reason, exitCode, stderr: sanitizeStderr(stderr) });
    return { ok: false, reason };
  }
}

function sanitizeStderr(stderr: string): string {
  // Keep printable ASCII only and collapse whitespace into a single log line.
  return stderr
    .replace(/[^\x20-\x7e\n\t]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_STDERR_BYTES);
}

// ---------------------------------------------------------------------------
// Fake converter for service tests
// ---------------------------------------------------------------------------

export type FakeConversionStep =
  | ConversionResult
  | ((input: ConversionInput, options: ConversionOptions) => Promise<ConversionResult> | ConversionResult);

/** Scripted converter that records every call. Reuses the last step when the script runs out. */
export class FakeAudioConverter implements AudioConverter {
  readonly calls: Array<{ input: ConversionInput; options: ConversionOptions }> = [];
  private readonly steps: FakeConversionStep[];

  constructor(steps: FakeConversionStep[] = [{ ok: false, reason: 'failed' }]) {
    this.steps = steps;
  }

  async convert(input: ConversionInput, options: ConversionOptions): Promise<ConversionResult> {
    const index = Math.min(this.calls.length, this.steps.length - 1);
    this.calls.push({ input, options });
    const step = this.steps[index] ?? { ok: false, reason: 'failed' };
    return typeof step === 'function' ? step(input, options) : step;
  }
}
