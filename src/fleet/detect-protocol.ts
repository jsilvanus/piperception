import type { RawDetection } from '../types.js';

/**
 * Remote detection over fffleet: a stream job of type `perception-detect` runs on a worker that has the
 * executor (src/fleet/detect-executor.ts). It reads the camera stream itself, runs YOLOX there and writes
 * one JSON line per analysed frame to its stdout. Only these small lines travel back to piperception,
 * no frames.
 */
export const DETECT_JOB_TYPE = 'perception-detect';
export const DETECT_PROTOCOL_VERSION = 1;

/** Model names the worker may load: a file `<name>.onnx` in its model directory. */
export const MODEL_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export interface DetectPayload {
  fps: number;
  width: number;
  height: number;
  /** Model name, e.g. yolox_tiny (the worker resolves it in its own model directory). */
  model: string;
  inputSize: number;
  channelOrder: 'bgr' | 'rgb';
  confThreshold: number;
  nmsThreshold: number;
}

export interface DetectJobOptions extends Partial<DetectPayload> {
  streamUrl: string;
  cameraId: string;
  workerPreference?: string[] | undefined;
  requires?: string[] | undefined;
}

export const DEFAULT_REMOTE_MODEL = 'yolox_tiny';

export function buildDetectJobSpec(o: DetectJobOptions): Record<string, unknown> {
  const payload: DetectPayload = {
    fps: o.fps ?? 5,
    width: o.width ?? 640,
    height: o.height ?? 480,
    model: o.model ?? DEFAULT_REMOTE_MODEL,
    inputSize: o.inputSize ?? 416,
    channelOrder: o.channelOrder ?? 'bgr',
    confThreshold: o.confThreshold ?? 0.35,
    nmsThreshold: o.nmsThreshold ?? 0.45,
  };
  const spec: Record<string, unknown> = {
    type: DETECT_JOB_TYPE,
    kind: 'stream',
    class: 'stream',
    stdout: true,
    labels: { app: 'piperception', camera: o.cameraId, role: 'detect' },
    inputs: [{ name: 'src', uri: o.streamUrl }],
    [DETECT_JOB_TYPE]: payload,
  };
  if (o.workerPreference?.length) spec.workerPreference = o.workerPreference;
  if (o.requires?.length) spec.requires = o.requires;
  return spec;
}

/** Checks a payload on the worker side; throws with a short message. */
export function readDetectPayload(spec: Record<string, any>): DetectPayload {
  const p = spec?.[DETECT_JOB_TYPE];
  if (!p || typeof p !== 'object') throw new Error(`spec.${DETECT_JOB_TYPE} is required`);
  const int = (v: unknown, lo: number, hi: number, name: string) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`${name} must be an integer ${lo}..${hi}`);
    return v;
  };
  const num = (v: unknown, name: string) => {
    if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new Error(`${name} must be 0..1`);
    return v;
  };
  if (typeof p.model !== 'string' || !MODEL_NAME_RE.test(p.model)) throw new Error('model must be a plain model name');
  return {
    fps: int(p.fps, 1, 30, 'fps'),
    width: int(p.width, 32, 1920, 'width'),
    height: int(p.height, 32, 1080, 'height'),
    model: p.model,
    inputSize: int(p.inputSize, 64, 1280, 'inputSize'),
    channelOrder: p.channelOrder === 'rgb' ? 'rgb' : 'bgr',
    confThreshold: num(p.confThreshold, 'confThreshold'),
    nmsThreshold: num(p.nmsThreshold, 'nmsThreshold'),
  };
}

/** One line of the job's stdout. `hello` comes first, then one `frame` line per analysed frame. */
export type DetectLine =
  | { v: 1; type: 'hello'; model: string; providers: string[] }
  | { v: 1; type: 'frame'; ts: number; ms: number; d: Array<[x: number, y: number, w: number, h: number, score: number]> };

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function encodeFrameLine(tsMs: number, inferenceMs: number, dets: RawDetection[]): string {
  const line: DetectLine = {
    v: 1,
    type: 'frame',
    ts: tsMs,
    ms: Math.round(inferenceMs * 10) / 10,
    d: dets.map((x) => [r4(x.rect.x), r4(x.rect.y), r4(x.rect.w), r4(x.rect.h), Math.round(x.score * 1000) / 1000]),
  };
  return JSON.stringify(line) + '\n';
}

export function encodeHelloLine(model: string, providers: string[]): string {
  return JSON.stringify({ v: 1, type: 'hello', model, providers } satisfies DetectLine) + '\n';
}

/** Person detections of a `frame` line (the remote detector reports persons only). */
export function frameLineDetections(line: Extract<DetectLine, { type: 'frame' }>): RawDetection[] {
  return line.d.map(([x, y, w, h, score]) => ({ rect: { x, y, w, h }, score, classIndex: 0, label: 'person' }));
}

/** Splits an NDJSON byte stream into parsed lines; bad lines are counted and skipped. */
export class DetectLineReader {
  private rest = '';
  bad = 0;

  push(chunk: Buffer | string): DetectLine[] {
    const text = this.rest + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    const parts = text.split('\n');
    this.rest = parts.pop() ?? '';
    if (this.rest.length > 1_000_000) this.rest = '';
    const out: DetectLine[] = [];
    for (const part of parts) {
      if (!part.trim()) continue;
      try {
        const v = JSON.parse(part);
        if (v?.v === DETECT_PROTOCOL_VERSION && (v.type === 'hello' || (v.type === 'frame' && Array.isArray(v.d)))) out.push(v);
        else this.bad++;
      } catch {
        this.bad++;
      }
    }
    return out;
  }
}
