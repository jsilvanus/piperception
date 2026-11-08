import fs from 'node:fs';
import type { DetectorBackend } from './types.js';
import type { RawDetection } from '../types.js';
import {
  anchorCount,
  decodeYoloxCandidates,
  nms,
  COCO_PERSON_CLASS,
} from './yolox-decoder.js';
import type { Frame } from '../ingest/frame.js';
import { frameToRgb, letterbox, unletterbox } from '../preprocess/yolox-input.js';

function isFrame(v: unknown): v is Frame {
  return !!v && typeof v === 'object' && Buffer.isBuffer((v as Frame).data) && typeof (v as Frame).format === 'string';
}

export interface OnnxDetectorOptions {
  modelPath: string;
  inputSize?: number | undefined;
  confThreshold?: number | undefined;
  nmsThreshold?: number | undefined;
  /** Channel order the model was trained with (official YOLOX: bgr). */
  channelOrder?: 'bgr' | 'rgb' | undefined;
  /** The model was exported with the box decode inside (--decode_in_inference). */
  decodedOutput?: boolean | undefined;
  /** onnxruntime execution providers, e.g. ['cuda', 'cpu']. Default ['cpu']. */
  executionProviders?: string[] | undefined;
  /** onnxruntime intra-op threads (unset = onnxruntime's default, all cores). 2 suits a Pi 4. */
  threads?: number | undefined;
}

export class OnnxDetector implements DetectorBackend {
  readonly name = 'onnx';
  private session: any = null;
  private ort: any = null;
  private readonly modelPath: string;
  private readonly inputSize: number;
  private readonly confThreshold: number;
  private readonly nmsThreshold: number;
  private readonly channelOrder: 'bgr' | 'rgb';
  private readonly decodedOutput: boolean;
  private readonly executionProviders: string[];
  private readonly threads: number | undefined;

  constructor(options: OnnxDetectorOptions) {
    this.modelPath = options.modelPath;
    this.inputSize = options.inputSize ?? 416;
    this.confThreshold = options.confThreshold ?? 0.35;
    this.nmsThreshold = options.nmsThreshold ?? 0.45;
    this.channelOrder = options.channelOrder ?? 'bgr';
    this.decodedOutput = options.decodedOutput ?? false;
    this.executionProviders = options.executionProviders ?? ['cpu'];
    this.threads = options.threads && options.threads > 0 ? options.threads : undefined;
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`ONNX model file not found: ${this.modelPath}`);
    }

    try {
      // @ts-ignore - optional dynamic runtime dependency
      this.ort = await import('onnxruntime-node');
    } catch (err: any) {
      throw new Error(`onnxruntime-node is not installed (${err.message}). Run: pnpm add onnxruntime-node`);
    }

    const runtime = this.ort.default ?? this.ort;
    this.session = await runtime.InferenceSession.create(this.modelPath, {
      executionProviders: this.executionProviders,
      graphOptimizationLevel: 'all',
      ...(this.threads ? { intraOpNumThreads: this.threads, interOpNumThreads: 1 } : {}),
    });
  }

  async detect(frame?: Frame | Buffer | unknown): Promise<RawDetection[]> {
    if (!isFrame(frame)) {
      // A bare buffer carries no size or format; nothing honest can be detected from it.
      return [];
    }
    if (!this.session) {
      await this.init();
    }

    const rgb = frameToRgb(frame);
    const { tensor: input, ratio } = letterbox(rgb, this.inputSize, { channelOrder: this.channelOrder });

    const runtime = this.ort.default ?? this.ort;
    const inputName = this.session.inputNames[0];
    const outputName = this.session.outputNames[0];
    const tensor = new runtime.Tensor('float32', input, [1, 3, this.inputSize, this.inputSize]);

    const results = await this.session.run({ [inputName]: tensor });
    const output = results[outputName];
    if (!output || !output.data) return [];

    const expectedAnchors = anchorCount(this.inputSize);
    const dims = output.dims;
    const anchors = dims[dims.length - 2] ?? expectedAnchors;
    const cols = dims[dims.length - 1] ?? 85;

    const candidates = decodeYoloxCandidates(output.data as Float32Array, anchors, this.inputSize, {
      classes: cols - 5,
      targetClassIndex: COCO_PERSON_CLASS,
      minScore: this.confThreshold,
      // Raw head output (the official export) needs the grid decode; an export with decode built in does not.
      decode: anchors === expectedAnchors && !this.decodedOutput,
    });

    const kept = nms(candidates, this.nmsThreshold);
    return kept.map((c) => unletterbox(c, ratio, rgb.width, rgb.height));
  }

  async close(): Promise<void> {
    if (this.session && typeof this.session.release === 'function') {
      await this.session.release();
      this.session = null;
    }
  }
}
