import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { frameToRgb, letterbox, unletterbox } from '../src/preprocess/yolox-input.js';
import { OnnxDetector } from '../src/detector/onnx-backend.js';
import { selectDetector } from '../src/detector/select.js';
import { anchorCount } from '../src/detector/yolox-decoder.js';

test('letterbox: 640x480 into 416 keeps aspect, pads with 114 at bottom, BGR NCHW', () => {
  const w = 640, h = 480;
  const data = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { data[i * 3] = 200; data[i * 3 + 1] = 100; data[i * 3 + 2] = 10; } // R G B
  const { tensor, ratio, size } = letterbox({ width: w, height: h, data }, 416);
  assert.equal(size, 416);
  assert.equal(ratio, 416 / 640);
  const plane = 416 * 416;
  const at = (c: number, x: number, y: number) => tensor[c * plane + y * 416 + x]!;
  // resized height 312; inside: channel 0 is blue
  assert.equal(at(0, 10, 10), 10);
  assert.equal(at(1, 10, 10), 100);
  assert.equal(at(2, 10, 10), 200);
  assert.equal(at(0, 10, 311), 10);
  // padding below
  assert.equal(at(0, 10, 312), 114);
  assert.equal(at(2, 415, 415), 114);
  // rgb order on request
  assert.equal(letterbox({ width: w, height: h, data }, 416, { channelOrder: 'rgb' }).tensor[0], 200);
});

test('letterbox bilinear resize keeps a left/right split in place', () => {
  const w = 8, h = 4;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[(y * w + x) * 3] = x < 4 ? 0 : 255;
  const { tensor } = letterbox({ width: w, height: h, data }, 4);
  const plane = 16;
  // R goes to channel 2 (BGR); 4x2 image after resize
  assert.equal(tensor[2 * plane + 0], 0);
  assert.equal(tensor[2 * plane + 3], 255);
});

test('unletterbox maps model pixels back to normalised frame coordinates', () => {
  const ratio = 416 / 640;
  // a box covering x 64..192, y 96..288 in a 640x480 frame
  const c = { x: 64 * ratio, y: 96 * ratio, w: 128 * ratio, h: 192 * ratio, score: 0.87654, classIndex: 0 };
  const d = unletterbox(c, ratio, 640, 480);
  assert.ok(Math.abs(d.rect.x - 0.1) < 1e-9);
  assert.ok(Math.abs(d.rect.y - 0.2) < 1e-9);
  assert.ok(Math.abs(d.rect.w - 0.2) < 1e-9);
  assert.ok(Math.abs(d.rect.h - 0.4) < 1e-9);
  assert.equal(d.score, 0.877);
  assert.equal(d.label, 'person');
  // a box reaching into the padding is cut at the frame edge
  const edge = unletterbox({ x: 0, y: 300, w: 50, h: 100, score: 1, classIndex: 0 }, ratio, 640, 480);
  assert.ok(edge.rect.y + edge.rect.h <= 1 + 1e-9);
});

test('frameToRgb decodes JPEG and checks rgb24 size', () => {
  const img = jpeg.encode({ width: 16, height: 8, data: Buffer.alloc(16 * 8 * 4, 200) }, 95).data;
  const rgb = frameToRgb({ cameraId: 'c', tsMs: 0, format: 'jpeg', width: 0, height: 0, data: img });
  assert.equal(rgb.width, 16);
  assert.equal(rgb.height, 8);
  assert.equal(rgb.data.length, 16 * 8 * 3);
  assert.ok(Math.abs(rgb.data[0]! - 200) < 4);
  assert.throws(() => frameToRgb({ cameraId: 'c', tsMs: 0, format: 'rgb24', width: 4, height: 4, data: Buffer.alloc(5) }));
});

test('OnnxDetector feeds the letterboxed frame and maps boxes back (fake runtime)', async () => {
  const size = 416;
  const anchors = anchorCount(size);
  let seenInput: Float32Array | null = null;
  const det = new OnnxDetector({ modelPath: '/nonexistent', inputSize: size, confThreshold: 0.3, decodedOutput: true });
  const out = new Float32Array(anchors * 85);
  // one decoded box: centre (104, 104), 52x104 in input pixels
  out.set([104, 104, 52, 104, 0.9, 0.9], 0);
  (det as any).ort = { Tensor: class { constructor(_t: string, public data: Float32Array) { seenInput = data; } } };
  (det as any).session = {
    inputNames: ['images'], outputNames: ['output'],
    run: async () => ({ output: { data: out, dims: [1, anchors, 85] } }),
  };
  const data = Buffer.alloc(640 * 480 * 3, 50);
  const dets = await det.detect({ cameraId: 'cam1', tsMs: 0, format: 'rgb24', width: 640, height: 480, data });
  assert.ok(seenInput);
  assert.equal(seenInput![0], 50);
  assert.equal(seenInput![size * size - 1], 114); // bottom-right is padding
  assert.equal(dets.length, 1);
  const r = 416 / 640;
  assert.ok(Math.abs(dets[0]!.rect.x - (78 / r) / 640) < 1e-6);
  assert.ok(Math.abs(dets[0]!.rect.h - (104 / r) / 480) < 1e-6);
  // a bare buffer is not a frame: nothing
  assert.deepEqual(await det.detect(Buffer.alloc(10)), []);
});

test('selectDetector falls back to the stub with a reason', async () => {
  assert.equal((await selectDetector({})).info.reason, 'PERCEPTION_MODEL_PATH is not set');
  const missing = await selectDetector({ modelPath: '/no/such/model.onnx' });
  assert.equal(missing.info.name, 'stub');
  assert.match(missing.info.reason!, /not found/);
  const broken = await selectDetector({ modelPath: import.meta.filename }, () => ({
    name: 'onnx', detect: async () => [], init: async () => { throw new Error('onnxruntime-node is not installed'); },
  }));
  assert.equal(broken.detector.name, 'stub');
  assert.match(broken.info.reason!, /onnxruntime/);
  const ok = await selectDetector({ modelPath: import.meta.filename }, () => ({ name: 'onnx', detect: async () => [], init: async () => {} }));
  assert.equal(ok.info.name, 'onnx');
});
