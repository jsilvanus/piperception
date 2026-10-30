import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationDetector } from '../src/detector/simulation-backend.js';

test('SimulationDetector produces valid bounding boxes within [0, 1] range', async () => {
  const sim = new SimulationDetector('altar');
  const dets = await sim.detect();

  assert.equal(dets.length, 1);
  const d = dets[0]!;
  assert.equal(d.label, 'person');
  assert.ok(d.score >= 0.7);
  assert.ok(d.rect.x >= 0 && d.rect.x <= 1);
  assert.ok(d.rect.y >= 0 && d.rect.y <= 1);
  assert.ok(d.rect.w > 0 && d.rect.w <= 1);
  assert.ok(d.rect.h > 0 && d.rect.h <= 1);
});

test('SimulationDetector changes bounding box coordinates across paths', async () => {
  const sim = new SimulationDetector('pulpit');
  const dPulpit = (await sim.detect())[0]!;

  sim.setPath('choir');
  const dChoir = (await sim.detect())[0]!;

  // Pulpit is to the left (small x ~0.2), Choir is to the right (large x ~0.8)
  assert.ok(dPulpit.rect.x < 0.4);
  assert.ok(dChoir.rect.x > 0.6);
});
