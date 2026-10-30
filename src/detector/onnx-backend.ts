import fs from 'node:fs';
import type { DetectorBackend } from './types.js';
import type { RawDetection } from '../types.js';
import {
  anchorCount,
  decodeYoloxCandidates,
  nms,
  candidateToNormalized,
  COCO_PERSON_CLASS,
} from './yolox-decoder.js';

export interface OnnxDetectorOptions {
  modelPath: string;
  inputSize?: number | undefined;
  confThreshold?: number | undefined;
  nmsThreshold?: number | undefined;
}

export class OnnxDetector implements DetectorBackend {
  readonly name = 'onnx';
  private session: any = null;
  private ort: any = null;
  private readonly modelPath: string;
  private readonly inputSize: number;
  private readonly confThreshold: number;
  private readonly nmsThreshold: number;

  constructor(options: OnnxDetectorOptions) {
    this.modelPath = options.modelPath;
    this.inputSize = options.inputSize ?? 416;
    this.confThreshold = options.confThreshold ?? 0.35;
    this.nmsThreshold = options.nmsThreshold ?? 0.45;
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`ONNX model file not found: ${this.modelPath}`);
    }

    try {
      // @ts-ignore - optional dynamic runtime dependency
      this.ort = await import('onnxruntime-node');
    } catch (err: any) {
      throw new Error(`onnxruntime-node is not installed (${err.message}). Run: npm install onnxruntime-node`);
    }

    const runtime = this.ort.default ?? this.ort;
    this.session = await runtime.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }

  async detect(frame?: Buffer | unknown): Promise<RawDetection[]> {
    if (!this.session) {
      await this.init();
    }

    if (!frame || !Buffer.isBuffer(frame)) {
      return [];
    }

    // Tensor inference
    const runtime = this.ort.default ?? this.ort;
    const inputName = this.session.inputNames[0];
    const outputName = this.session.outputNames[0];

    // Placeholder for actual image buffer tensor (NCHW float32)
    const floatData = new Float32Array(3 * this.inputSize * this.inputSize);
    const tensor = new runtime.Tensor('float32', floatData, [1, 3, this.inputSize, this.inputSize]);

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
      decode: anchors === expectedAnchors,
    });

    const kept = nms(candidates, this.nmsThreshold);
    return kept.map((c) => candidateToNormalized(c, this.inputSize, this.inputSize));
  }

  async close(): Promise<void> {
    if (this.session && typeof this.session.release === 'function') {
      await this.session.release();
      this.session = null;
    }
  }
}
