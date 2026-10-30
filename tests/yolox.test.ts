import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorCount,
  decodeYoloxCandidates,
  nms,
  candidateToNormalized,
} from '../src/detector/yolox-decoder.js';

test('anchorCount calculates correct anchors for strides 8, 16, 32', () => {
  // 640 input: (640/8)^2 + (640/16)^2 + (640/32)^2 = 6400 + 1600 + 400 = 8400
  assert.equal(anchorCount(640), 8400);

  // 416 input: (416/8)^2 + (416/16)^2 + (416/32)^2 = 2704 + 676 + 169 = 3549
  assert.equal(anchorCount(416), 3549);
});

test('decodeYoloxCandidates extracts candidates exceeding threshold', () => {
  const anchors = 2;
  const classes = 80;
  const rowStride = 5 + classes;
  const tensor = new Float32Array(anchors * rowStride);

  // Anchor 0: high objectness (0.9), high person class score (0.9) => 0.81
  tensor[0] = 50;  // cx
  tensor[1] = 60;  // cy
  tensor[2] = 20;  // w
  tensor[3] = 40;  // h
  tensor[4] = 0.9; // objectness
  tensor[5] = 0.9; // class 0 (person)

  // Anchor 1: low objectness (0.1) => discarded
  const o1 = 1 * rowStride;
  tensor[o1 + 4] = 0.1;
  tensor[o1 + 5] = 0.5;

  const candidates = decodeYoloxCandidates(tensor, anchors, 416, {
    classes: 80,
    targetClassIndex: 0,
    minScore: 0.3,
    decode: false,
  });

  assert.equal(candidates.length, 1);
  assert.ok(candidates[0]!.score > 0.8);
  assert.equal(candidates[0]!.w, 20);
  assert.equal(candidates[0]!.h, 40);
});

test('nms suppresses overlapping boxes with lower scores', () => {
  const c1 = { x: 10, y: 10, w: 50, h: 50, score: 0.95, classIndex: 0 };
  const c2 = { x: 12, y: 12, w: 48, h: 48, score: 0.80, classIndex: 0 }; // High overlap
  const c3 = { x: 200, y: 200, w: 50, h: 50, score: 0.90, classIndex: 0 }; // Separate box

  const kept = nms([c1, c2, c3], 0.5);
  assert.equal(kept.length, 2);
  assert.equal(kept[0]!.score, 0.95);
  assert.equal(kept[1]!.score, 0.90);
});

test('candidateToNormalized converts to 0..1 bounding boxes', () => {
  const c = { x: 100, y: 50, w: 200, h: 300, score: 0.92, classIndex: 0 };
  const norm = candidateToNormalized(c, 1000, 1000);

  assert.equal(norm.label, 'person');
  assert.equal(norm.score, 0.92);
  assert.equal(norm.rect.x, 0.1);
  assert.equal(norm.rect.y, 0.05);
  assert.equal(norm.rect.w, 0.2);
  assert.equal(norm.rect.h, 0.3);
});
