import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FakeAudioConverter,
  FfmpegAudioConverter,
  ffmpegArgs,
  type ProcessExit,
  type ProcessRunOptions,
  type ProcessRunner,
} from './audioConverter.js';

interface Invocation {
  command: string;
  args: readonly string[];
  options: ProcessRunOptions;
  killed: string[];
  inputExisted: boolean;
  inputMode?: number;
}

type Script = (
  options: ProcessRunOptions,
  controls: { exit: (e: ProcessExit) => void; invocation: Invocation },
) => void;

/** Fake runner: records invocations and plays a script against the callbacks. */
function fakeRunner(script: Script): { runner: ProcessRunner; invocations: Invocation[] } {
  const invocations: Invocation[] = [];
  const runner: ProcessRunner = {
    run(command, args, options) {
      const inputPath = args[args.indexOf('-i') + 1] ?? '';
      const invocation: Invocation = {
        command,
        args,
        options,
        killed: [],
        inputExisted: existsSync(inputPath),
        inputMode: existsSync(inputPath) ? statSync(inputPath).mode & 0o777 : undefined,
      };
      invocations.push(invocation);
      let resolveExit!: (e: ProcessExit) => void;
      const exited = new Promise<ProcessExit>((r) => (resolveExit = r));
      const proc = {
        kill(signal: 'SIGKILL') {
          invocation.killed.push(signal);
          resolveExit({ code: null, signal });
        },
        exited,
      };
      queueMicrotask(() => script(options, { exit: resolveExit, invocation }));
      return proc;
    },
  };
  return { runner, invocations };
}

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);

describe('ffmpegArgs', () => {
  it('returns the fixed list with the matroska demuxer for webm', () => {
    expect(ffmpegArgs('webm', '/tmp/x/input.webm')).toEqual([
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
      '-threads', '1', '-f', 'matroska', '-i', '/tmp/x/input.webm', '-vn', '-map_metadata', '-1',
      '-t', '31', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
    ]);
  });

  it('differs only in the demuxer for mp4', () => {
    const webm = ffmpegArgs('webm', '/p');
    const mp4 = ffmpegArgs('mp4', '/p');
    const diffs = webm.map((a, i) => (a === mp4[i] ? null : [a, mp4[i]])).filter(Boolean);
    expect(diffs).toEqual([['matroska', 'mov']]);
  });
});

describe('FfmpegAudioConverter', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'sous-conv-test-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const options = (maxOutputBytes = 1_000) => ({ signal: new AbortController().signal, maxOutputBytes });

  it('returns PCM on success, spawns safely, writes a 0600 input file, and cleans up', async () => {
    const { runner, invocations } = fakeRunner((o, { exit }) => {
      o.onStdout(new Uint8Array([1, 2]));
      o.onStdout(new Uint8Array([3, 4]));
      exit({ code: 0, signal: null });
    });
    const converter = new FfmpegAudioConverter({ ffmpegPath: '/opt/bin/ffmpeg', runner, tmpRoot });

    const result = await converter.convert({ bytes: WEBM, container: 'webm' }, options());

    expect(result).toEqual({ ok: true, pcm: new Uint8Array([1, 2, 3, 4]) });
    const inv = invocations[0]!;
    expect(inv.command).toBe('/opt/bin/ffmpeg');
    expect(inv.options.shell).toBe(false);
    expect(inv.options.env).toEqual({});
    expect(inv.inputExisted).toBe(true);
    expect(inv.inputMode).toBe(0o600);
    const inputPath = inv.args[inv.args.indexOf('-i') + 1]!;
    expect(inv.args).toEqual(ffmpegArgs('webm', inputPath));
    expect(existsSync(dirname(inputPath))).toBe(false);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('kills with SIGKILL and returns too_large when output exceeds the limit', async () => {
    const { runner, invocations } = fakeRunner((o) => {
      o.onStdout(new Uint8Array(6));
    });
    const converter = new FfmpegAudioConverter({ ffmpegPath: 'ffmpeg', runner, tmpRoot });

    const result = await converter.convert({ bytes: WEBM, container: 'mp4' }, options(4));

    expect(result).toEqual({ ok: false, reason: 'too_large' });
    expect(invocations[0]!.killed).toEqual(['SIGKILL']);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('kills and returns timeout on abort', async () => {
    const controller = new AbortController();
    const { runner, invocations } = fakeRunner(() => controller.abort());
    const converter = new FfmpegAudioConverter({ ffmpegPath: 'ffmpeg', runner, tmpRoot });

    const result = await converter.convert(
      { bytes: WEBM, container: 'webm' },
      { signal: controller.signal, maxOutputBytes: 1_000 },
    );

    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(invocations[0]!.killed).toEqual(['SIGKILL']);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it.each([
    ['non-zero exit', { code: 1, signal: null }, [new Uint8Array(2)]],
    ['empty output', { code: 0, signal: null }, []],
    ['odd-length output', { code: 0, signal: null }, [new Uint8Array(3)]],
  ] as const)('returns failed on %s and keeps at most 4 KB of stderr', async (_name, exitInfo, out) => {
    const logs: string[] = [];
    const { runner } = fakeRunner((o, { exit }) => {
      for (const c of out) o.onStdout(c);
      o.onStderr(new Uint8Array(10_000).fill(0x61));
      exit(exitInfo);
    });
    const converter = new FfmpegAudioConverter({
      ffmpegPath: 'ffmpeg',
      runner,
      tmpRoot,
      log: (e) => logs.push(e.stderr),
    });

    const result = await converter.convert({ bytes: WEBM, container: 'webm' }, options());

    expect(result).toEqual({ ok: false, reason: 'failed' });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.length).toBeLessThanOrEqual(4096);
    expect(await readdir(tmpRoot)).toEqual([]);
  });
});

describe('FakeAudioConverter', () => {
  it('plays scripted results and records calls', async () => {
    const fake = new FakeAudioConverter([
      { ok: true, pcm: new Uint8Array(2) },
      { ok: false, reason: 'timeout' },
    ]);
    const opts = { signal: new AbortController().signal, maxOutputBytes: 10 };
    expect(await fake.convert({ bytes: WEBM, container: 'webm' }, opts)).toEqual({ ok: true, pcm: new Uint8Array(2) });
    expect(await fake.convert({ bytes: WEBM, container: 'mp4' }, opts)).toEqual({ ok: false, reason: 'timeout' });
    expect(await fake.convert({ bytes: WEBM, container: 'mp4' }, opts)).toEqual({ ok: false, reason: 'timeout' });
    expect(fake.calls.map((c) => c.input.container)).toEqual(['webm', 'mp4', 'mp4']);
  });
});
