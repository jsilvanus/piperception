import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { StreamManager } from '../src/stream/stream-manager.js';
import { PiSpacePusher } from '../src/sink/pispace-pusher.js';
import { StubDetector } from '../src/detector/stub-backend.js';

test('Fastify server endpoints and manual frame processing', async () => {
  const pusher = new PiSpacePusher('http://127.0.0.1:3203');
  const streamManager = new StreamManager(pusher, false);

  const stub = new StubDetector([
    {
      rect: { x: 0.3, y: 0.3, w: 0.2, h: 0.4 },
      score: 0.95,
      classIndex: 0,
      label: 'person',
    },
  ]);

  streamManager.addStream(
    {
      cameraId: 'cam1',
      sourceType: 'mock',
      enabled: false,
    },
    stub
  );

  const app = createServer(streamManager, pusher, {
    port: 3202,
    host: '127.0.0.1',
    pispaceUrl: 'http://127.0.0.1:3203',
    autoPushPiSpace: false,
    defaultFps: 10,
    streams: [],
  });

  // Health
  const resHealth = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(resHealth.statusCode, 200);
  assert.equal(resHealth.json().ok, true);

  // Streams list
  const resStreams = await app.inject({ method: 'GET', url: '/api/v1/streams' });
  assert.equal(resStreams.statusCode, 200);
  assert.equal(resStreams.json().length, 1);
  assert.equal(resStreams.json()[0].cameraId, 'cam1');

  // Dashboard HTML
  const resDash = await app.inject({ method: 'GET', url: '/' });
  assert.equal(resDash.statusCode, 200);
  assert.ok(resDash.body.includes('PiPerception Console'));

  // Pusher Stats
  const resPush = await app.inject({ method: 'GET', url: '/api/v1/pusher' });
  assert.equal(resPush.statusCode, 200);
  assert.equal(resPush.json().pushCount, 0);

  // Manual frame processing (Frame 1)
  const resF1 = await app.inject({
    method: 'POST',
    url: '/api/v1/cameras/cam1/frame',
    payload: {},
  });
  assert.equal(resF1.statusCode, 200);

  // Manual frame processing (Frame 2 - confirms track)
  const resF2 = await app.inject({
    method: 'POST',
    url: '/api/v1/cameras/cam1/frame',
    payload: {},
  });
  assert.equal(resF2.statusCode, 200);
  const jsonF2 = resF2.json();
  assert.equal(jsonF2.cameraId, 'cam1');
  assert.equal(jsonF2.objects.length, 1);
  assert.equal(jsonF2.objects[0].trackId, 1);
  assert.equal(jsonF2.objects[0].label, 'person');
  assert.ok(Array.isArray(jsonF2.objects[0].bbox));

  // Check tracks endpoint
  const resTracks = await app.inject({ method: 'GET', url: '/api/v1/tracks' });
  assert.equal(resTracks.statusCode, 200);
  assert.equal(resTracks.json().cam1.length, 1);

  streamManager.stopAll();
  await app.close();
});
