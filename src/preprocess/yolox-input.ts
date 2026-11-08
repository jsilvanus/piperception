import jpeg from 'jpeg-js';
import type { Frame } from '../ingest/frame.js';
import type { RawDetection } from '../types.js';
import { COCO_PERSON_CLASS, type CandidateBox } from '../detector/yolox-decoder.js';

export interface RgbImage {
  width: number;
  height: number;
  /** Packed RGB, 3 bytes per pixel. */
  data: Uint8Array;
}

/** Turns a feed frame into packed RGB: rgb24 as is, JPEG decoded in pure JS (jpeg-js). */
export function frameToRgb(frame: Frame): RgbImage {
  if (frame.format === 'rgb24') {
    const expected = frame.width * frame.height * 3;
    if (frame.data.length !== expected) {
      throw new Error(`rgb24 frame has ${frame.data.length} bytes, expected ${expected} for ${frame.width}x${frame.height}`);
    }
    return { width: frame.width, height: frame.height, data: frame.data };
  }
  const img = jpeg.decode(frame.data, { useTArray: true, formatAsRGBA: false, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
  return { width: img.width, height: img.height, data: img.data };
}

export interface LetterboxResult {
  /** NCHW float32, 1 x 3 x size x size. */
  tensor: Float32Array;
  size: number;
  /** Scale from frame pixels to model input pixels. */
  ratio: number;
}

export interface LetterboxOptions {
  /** Channel order the model expects. YOLOX models exported from the official repo take BGR (OpenCV order). */
  channelOrder?: 'bgr' | 'rgb';
  /** Fill value of the padding (YOLOX: 114). */
  padValue?: number;
}

/**
 * YOLOX preprocessing ("preproc" in the YOLOX repo): scale the image by r = min(size/w, size/h) keeping its
 * aspect, put it in the top-left corner of a size x size canvas filled with 114, bilinear resize, values
 * 0..255 without mean/std normalisation, channels BGR, layout NCHW.
 */
export function letterbox(img: RgbImage, size: number, options: LetterboxOptions = {}): LetterboxResult {
  const pad = options.padValue ?? 114;
  const bgr = (options.channelOrder ?? 'bgr') === 'bgr';
  const ratio = Math.min(size / img.width, size / img.height);
  const rw = Math.max(1, Math.round(img.width * ratio));
  const rh = Math.max(1, Math.round(img.height * ratio));
  const plane = size * size;
  const tensor = new Float32Array(3 * plane).fill(pad);
  const src = img.data;
  const sw = img.width;
  const sh = img.height;
  // Output channel index for source R, G, B.
  const cR = bgr ? 2 : 0;
  const cB = bgr ? 0 : 2;
  const sx = sw / rw;
  const sy = sh / rh;
  for (let y = 0; y < rh; y++) {
    // Pixel-centre mapping, as cv2.resize INTER_LINEAR.
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(sh - 1, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < rw; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      const x0 = Math.min(sw - 1, Math.floor(fx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * sw + x0) * 3;
      const i01 = (y0 * sw + x1) * 3;
      const i10 = (y1 * sw + x0) * 3;
      const i11 = (y1 * sw + x1) * 3;
      const o = y * size + x;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c]! * (1 - wx) + src[i01 + c]! * wx;
        const bottom = src[i10 + c]! * (1 - wx) + src[i11 + c]! * wx;
        const v = top * (1 - wy) + bottom * wy;
        const outC = c === 0 ? cR : c === 2 ? cB : 1;
        tensor[outC * plane + o] = v;
      }
    }
  }
  return { tensor, size, ratio };
}

/** Maps a box in model-input pixels back through the letterbox to a normalised box of the original frame. */
export function unletterbox(c: CandidateBox, ratio: number, frameWidth: number, frameHeight: number): RawDetection {
  const x1 = clamp(c.x / ratio, 0, frameWidth);
  const y1 = clamp(c.y / ratio, 0, frameHeight);
  const x2 = clamp((c.x + c.w) / ratio, 0, frameWidth);
  const y2 = clamp((c.y + c.h) / ratio, 0, frameHeight);
  return {
    rect: {
      x: x1 / frameWidth,
      y: y1 / frameHeight,
      w: Math.max(0.001, (x2 - x1) / frameWidth),
      h: Math.max(0.001, (y2 - y1) / frameHeight),
    },
    score: Math.round(c.score * 1000) / 1000,
    classIndex: c.classIndex,
    label: c.classIndex === COCO_PERSON_CLASS ? 'person' : `class_${c.classIndex}`,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
