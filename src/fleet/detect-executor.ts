/**
 * fffleet executor for job type `perception-detect` (see detect-protocol.ts). Load it on a worker with
 *   FFFLEET_EXECUTORS=/app/dist/fleet/detect-executor.js
 * Worker environment:
 *   PERCEPTION_MODEL_DIR       directory with <model>.onnx files (default /models)
 *   PERCEPTION_ORT_PROVIDERS   onnxruntime execution providers (default cpu; e.g. cuda,cpu)
 *   PERCEPTION_ORT_THREADS     onnxruntime intra-op threads (default: onnxruntime's choice)
 *
 * The job reads its `src` input (rtsp/rtmp/srt/http) with ffmpeg as raw rgb24 frames at the requested size
 * and rate, runs YOLOX on the newest frame whenever the detector is free (frames in between are dropped, so
 * a slow detector never builds a backlog) and writes one NDJSON line per analysed frame to stdout.
 * One onnxruntime session per model is shared by all jobs on the worker, and runs one frame at a time.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { OnnxDetector } from '../detector/onnx-backend.js';
import type { DetectorBackend } from '../detector/types.js';
import { RawFrameSplitter, type Frame } from '../ingest/frame.js';
import type { RawDetection } from '../types.js';
import { DETECT_JOB_TYPE, encodeFrameLine, encodeHelloLine, readDetectPayload, type DetectPayload } from './detect-protocol.js';

const KILL_GRACE_MS = 3000;
const TAIL_CHARS = 2000;
const ALLOWED_SCHEMES = new Set(['rtsp:', 'rtsps:', 'rtmp:', 'rtmps:', 'srt:', 'http:', 'https:']);

export interface DetectRuntime {
  signal: AbortSignal;
  ffmpegPath?: string;
  attachStdout?(s: NodeJS.ReadableStream): void;
  setState?(state: string, extra?: Record<string, unknown>): void;
  stderr?(tail: string): void;
}

export interface DetectDeps {
  env?: NodeJS.ProcessEnv;
  /** Creates (or reuses) the detector for a payload. */
  detectorFor?(payload: DetectPayload, env: NodeJS.ProcessEnv): Promise<{ detector: DetectorBackend; providers: string[] }>;
  spawnFfmpeg?(cmd: string, args: string[]): ChildProcess;
}

function fail(code: string, message: string, details?: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { code: string; details?: Record<string, unknown> };
  err.code = code;
  if (details) err.details = details;
  return err;
}

/** Serialises calls into one detector, so jobs sharing a session do not run it in parallel. */
class Serial implements DetectorBackend {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly inner: DetectorBackend) {}
  get name() {
    return this.inner.name;
  }
  detect(frame?: unknown): Promise<RawDetection[]> {
    const next = this.chain.then(() => this.inner.detect(frame));
    this.chain = next.catch(() => undefined);
    return next;
  }
}

const sessions = new Map<string, Promise<{ detector: DetectorBackend; providers: string[] }>>();

async function defaultDetectorFor(p: DetectPayload, env: NodeJS.ProcessEnv) {
  const dir = env.PERCEPTION_MODEL_DIR || '/models';
  const providers = (env.PERCEPTION_ORT_PROVIDERS || 'cpu').split(',').map((s) => s.trim()).filter(Boolean);
  const threads = Number.parseInt(env.PERCEPTION_ORT_THREADS ?? '', 10) || undefined;
  const key = [threads ?? 0, p.model, p.inputSize, p.channelOrder, p.confThreshold, p.nmsThreshold, providers.join(',')].join('|');
  let entry = sessions.get(key);
  if (!entry) {
    entry = (async () => {
      const modelPath = join(dir, `${p.model}.onnx`);
      if (!existsSync(modelPath)) throw fail('BAD_SPEC', `model ${p.model} is not installed on this worker`);
      const d = new OnnxDetector({
        modelPath,
        inputSize: p.inputSize,
        channelOrder: p.channelOrder,
        confThreshold: p.confThreshold,
        nmsThreshold: p.nmsThreshold,
        executionProviders: providers,
        threads,
      });
      await d.init();
      return { detector: new Serial(d) as DetectorBackend, providers };
    })();
    sessions.set(key, entry);
    entry.catch(() => sessions.delete(key));
  }
  return entry;
}

export function ffmpegArgs(url: string, p: DetectPayload): string[] {
  const pre = url.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : [];
  return [
    '-hide_banner', '-nostats', '-loglevel', 'warning',
    ...pre, '-i', url, '-an',
    '-vf', `fps=${p.fps},scale=${p.width}:${p.height}`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
  ];
}

export async function runDetect(spec: Record<string, any>, rt: DetectRuntime, deps: DetectDeps = {}): Promise<{ exitCode: number; stderrTail: string | null }> {
  const env = deps.env ?? process.env;
  let payload: DetectPayload;
  try {
    payload = readDetectPayload(spec);
  } catch (err: any) {
    throw fail('BAD_SPEC', err.message);
  }
  const input = Array.isArray(spec.inputs) ? spec.inputs.find((i: any) => i?.name === 'src') : undefined;
  let url: URL;
  try {
    url = new URL(input?.uri);
  } catch {
    throw fail('BAD_SPEC', 'input "src" must be a stream URL');
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) throw fail('BAD_SPEC', `input scheme ${url.protocol} is not allowed`);

  const { detector, providers } = await (deps.detectorFor ?? defaultDetectorFor)(payload, env);
  rt.signal.throwIfAborted();

  const out = new PassThrough();
  rt.attachStdout?.(out);
  out.write(encodeHelloLine(payload.model, providers));

  const cmd = rt.ffmpegPath || 'ffmpeg';
  const child = (deps.spawnFfmpeg ?? ((c, a) => spawn(c, a, { stdio: ['ignore', 'pipe', 'pipe'] })))(cmd, ffmpegArgs(url.href, payload));
  rt.setState?.('running', child.pid ? { pid: child.pid } : undefined);

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (s: string) => {
    stderr = (stderr + s).slice(-TAIL_CHARS);
    rt.stderr?.(stderr);
  });

  const splitter = new RawFrameSplitter(payload.width, payload.height);
  let pending: Frame | null = null;
  let busy = false;
  let detectError: Error | null = null;
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (pending && !detectError) {
      const frame: Frame = pending;
      pending = null;
      const t0 = performance.now();
      try {
        const dets = await detector.detect(frame);
        out.write(encodeFrameLine(frame.tsMs, performance.now() - t0, dets));
      } catch (err: any) {
        detectError = fail('DETECT_FAILED', `detection failed: ${err?.message ?? err}`);
        child.kill('SIGTERM');
      }
    }
    busy = false;
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const data of splitter.push(chunk)) {
      pending = { cameraId: String(spec.labels?.camera ?? 'cam'), tsMs: Date.now(), format: 'rgb24', width: payload.width, height: payload.height, data };
    }
    void pump();
  });

  const onAbort = () => {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
  };
  rt.signal.addEventListener('abort', onAbort, { once: true });

  const code: number | null = await new Promise((resolve) => {
    child.once('error', (err) => {
      stderr = (stderr + `\n${err.message}`).slice(-TAIL_CHARS);
      resolve(-1);
    });
    child.once('close', (c) => resolve(c));
  });
  rt.signal.removeEventListener('abort', onAbort);
  while (busy) await new Promise((r) => setTimeout(r, 5));
  out.end();

  if (rt.signal.aborted) throw rt.signal.reason;
  if (detectError) throw detectError;
  if (code !== 0) throw fail('FFMPEG_FAILED', `ffmpeg exited with ${code}`, { exitCode: code, stderrTail: stderr || null });
  return { exitCode: 0, stderrTail: stderr || null };
}

export default { type: DETECT_JOB_TYPE, run: (spec: Record<string, any>, rt: DetectRuntime) => runDetect(spec, rt) };
