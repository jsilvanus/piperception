import type { RectBox, RawDetection } from '../types.js';

export const YOLOX_STRIDES = [8, 16, 32];
export const COCO_PERSON_CLASS = 0;

export function anchorCount(size: number, strides = YOLOX_STRIDES): number {
  return strides.reduce((n, s) => n + (size / s) * (size / s), 0);
}

export interface CandidateBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  classIndex: number;
}

export function decodeYoloxCandidates(
  data: Float32Array | number[],
  anchors: number,
  inputSize: number,
  options: {
    classes?: number;
    targetClassIndex?: number;
    minScore?: number;
    decode?: boolean;
    strides?: number[];
  } = {}
): CandidateBox[] {
  const classes = options.classes ?? 80;
  const targetClassIndex = options.targetClassIndex ?? COCO_PERSON_CLASS;
  const minScore = options.minScore ?? 0.3;
  const decode = options.decode ?? true;
  const strides = options.strides ?? YOLOX_STRIDES;

  const strideCols = 5 + classes;
  const candidates: CandidateBox[] = [];
  let row = 0;

  const emit = (gx: number, gy: number, s: number) => {
    const o = row * strideCols;
    row++;
    const objectness = data[o + 4]!;
    const classScore = data[o + 5 + targetClassIndex]!;
    const score = objectness * classScore;
    if (score < minScore) return;

    let cx = data[o]!;
    let cy = data[o + 1]!;
    let w = data[o + 2]!;
    let h = data[o + 3]!;

    if (decode) {
      cx = (cx + gx) * s;
      cy = (cy + gy) * s;
      w = Math.exp(w) * s;
      h = Math.exp(h) * s;
    }

    candidates.push({
      x: cx - w / 2,
      y: cy - h / 2,
      w,
      h,
      score,
      classIndex: targetClassIndex,
    });
  };

  if (decode) {
    for (const s of strides) {
      const n = inputSize / s;
      for (let gy = 0; gy < n; gy++) {
        for (let gx = 0; gx < n; gx++) {
          if (row < anchors) emit(gx, gy, s);
        }
      }
    }
  } else {
    for (let i = 0; i < anchors; i++) {
      emit(0, 0, 1);
    }
  }

  return candidates;
}

function iouBoxes(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Non-Maximum Suppression (NMS) */
export function nms(candidates: CandidateBox[], iouThreshold = 0.45): CandidateBox[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: CandidateBox[] = [];

  for (const c of sorted) {
    let discard = false;
    for (const k of kept) {
      if (iouBoxes(c, k) > iouThreshold) {
        discard = true;
        break;
      }
    }
    if (!discard) kept.push(c);
  }

  return kept;
}

/** Convert pixel box from detector to normalized [0, 1] rect */
export function candidateToNormalized(
  c: CandidateBox,
  inputWidth: number,
  inputHeight: number
): RawDetection {
  return {
    rect: {
      x: Math.max(0, Math.min(1, c.x / inputWidth)),
      y: Math.max(0, Math.min(1, c.y / inputHeight)),
      w: Math.max(0.01, Math.min(1, c.w / inputWidth)),
      h: Math.max(0.01, Math.min(1, c.h / inputHeight)),
    },
    score: Math.round(c.score * 1000) / 1000,
    classIndex: c.classIndex,
    label: c.classIndex === COCO_PERSON_CLASS ? 'person' : `class_${c.classIndex}`,
  };
}
