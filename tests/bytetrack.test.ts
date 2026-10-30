import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateIoU,
  hungarianAssign,
  ByteTracker,
  rectToBbox2D,
  bbox2DToRect,
} from '../src/tracker/bytetrack.js';
import type { RawDetection } from '../src/types.js';

test('calculateIoU handles exact matches, non-overlapping, and partial boxes', () => {
  const b1 = { x: 0.1, y: 0.1, w: 0.2, h: 0.4 };
  const b2 = { x: 0.1, y: 0.1, w: 0.2, h: 0.4 };
  assert.equal(calculateIoU(b1, b2), 1.0);

  const b3 = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
  assert.equal(calculateIoU(b1, b3), 0.0);

  // Partial overlap
  const b4 = { x: 0.2, y: 0.1, w: 0.2, h: 0.4 };
  const iou = calculateIoU(b1, b4);
  assert.ok(iou > 0.3 && iou < 0.4);
});

test('rectToBbox2D and bbox2DToRect bidirectional conversion', () => {
  const rect = { x: 0.2, y: 0.3, w: 0.4, h: 0.5 };
  const bbox = rectToBbox2D(rect);
  // [ymin, xmin, ymax, xmax]
  assert.equal(bbox[0], 0.3);
  assert.equal(bbox[1], 0.2);
  assert.equal(bbox[2], 0.8);
  assert.ok(Math.abs(bbox[3] - 0.6) < 1e-5);

  const recovered = bbox2DToRect(bbox);
  assert.ok(Math.abs(recovered.x - rect.x) < 1e-6);
  assert.ok(Math.abs(recovered.y - rect.y) < 1e-6);
  assert.ok(Math.abs(recovered.w - rect.w) < 1e-6);
  assert.ok(Math.abs(recovered.h - rect.h) < 1e-6);
});

test('hungarianAssign solves cost assignment', () => {
  const cost = [
    [0.1, 0.9],
    [0.8, 0.2],
  ];
  const matches = hungarianAssign(cost);
  assert.equal(matches.length, 2);
  assert.deepEqual(matches[0], [0, 0]);
  assert.deepEqual(matches[1], [1, 1]);
});

test('ByteTracker filters single-frame false positives (minHits)', () => {
  const tracker = new ByteTracker({ minHits: 2 });

  // Frame 1: Detection appears
  const det1: RawDetection = {
    rect: { x: 0.3, y: 0.3, w: 0.15, h: 0.4 },
    score: 0.88,
    classIndex: 0,
    label: 'person',
  };
  const tracks1 = tracker.update([det1]);
  // Not yet emitted because hits = 1 < minHits (2)
  assert.equal(tracks1.length, 0);

  // Frame 2: Same detection persists
  const tracks2 = tracker.update([det1]);
  assert.equal(tracks2.length, 1);
  assert.equal(tracks2[0]?.trackId, 1);
  assert.equal(tracks2[0]?.hits, 2);
});

test('ByteTracker maintains persistent track ID across moving frames', () => {
  const tracker = new ByteTracker({ minHits: 1 });

  // Move person across 3 frames
  const f1: RawDetection = { rect: { x: 0.20, y: 0.30, w: 0.15, h: 0.4 }, score: 0.9, classIndex: 0, label: 'person' };
  const f2: RawDetection = { rect: { x: 0.22, y: 0.30, w: 0.15, h: 0.4 }, score: 0.9, classIndex: 0, label: 'person' };
  const f3: RawDetection = { rect: { x: 0.24, y: 0.30, w: 0.15, h: 0.4 }, score: 0.9, classIndex: 0, label: 'person' };

  const t1 = tracker.update([f1]);
  assert.equal(t1.length, 1);
  const trackId = t1[0]!.trackId;

  const t2 = tracker.update([f2]);
  assert.equal(t2.length, 1);
  assert.equal(t2[0]!.trackId, trackId);

  const t3 = tracker.update([f3]);
  assert.equal(t3.length, 1);
  assert.equal(t3[0]!.trackId, trackId);
  assert.equal(t3[0]!.hits, 3);
});

test('ByteTracker keeps track alive during temporary low-score frame (Stage 2 association)', () => {
  const tracker = new ByteTracker({ minHits: 1, highScoreThresh: 0.5, lowScoreThresh: 0.2 });

  // Frame 1: Confident
  const f1: RawDetection = { rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.4 }, score: 0.9, classIndex: 0, label: 'person' };
  const t1 = tracker.update([f1]);
  const originalId = t1[0]!.trackId;

  // Frame 2: Occlusion / blur drops score to 0.3 (below highScoreThresh, above lowScoreThresh)
  const f2: RawDetection = { rect: { x: 0.41, y: 0.4, w: 0.2, h: 0.4 }, score: 0.3, classIndex: 0, label: 'person' };
  const t2 = tracker.update([f2]);
  assert.equal(t2.length, 1);
  assert.equal(t2[0]!.trackId, originalId);
});
