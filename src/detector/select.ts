import fs from 'node:fs';
import type { DetectorBackend } from './types.js';
import { OnnxDetector, type OnnxDetectorOptions } from './onnx-backend.js';
import { StubDetector } from './stub-backend.js';

export interface DetectorInfo {
  /** 'onnx' when a model is loaded, else 'stub' (detects nothing). */
  name: string;
  modelPath?: string | undefined;
  /** Why the stub is used, when it is. */
  reason?: string | undefined;
}

/**
 * The detector for real cameras: YOLOX through onnxruntime when PERCEPTION_MODEL_PATH points at a model
 * and onnxruntime-node loads it, otherwise the stub, with the reason (shown in /health).
 */
export async function selectDetector(
  options: Partial<OnnxDetectorOptions> & { modelPath?: string | undefined },
  create: (o: OnnxDetectorOptions) => DetectorBackend & { init(): Promise<void> } = (o) => new OnnxDetector(o)
): Promise<{ detector: DetectorBackend; info: DetectorInfo }> {
  if (!options.modelPath) {
    return { detector: new StubDetector(), info: { name: 'stub', reason: 'PERCEPTION_MODEL_PATH is not set' } };
  }
  if (!fs.existsSync(options.modelPath)) {
    return {
      detector: new StubDetector(),
      info: { name: 'stub', modelPath: options.modelPath, reason: `model file not found: ${options.modelPath}` },
    };
  }
  const detector = create(options as OnnxDetectorOptions);
  try {
    await detector.init();
    return { detector, info: { name: detector.name, modelPath: options.modelPath } };
  } catch (err: any) {
    return {
      detector: new StubDetector(),
      info: { name: 'stub', modelPath: options.modelPath, reason: err?.message ?? String(err) },
    };
  }
}
