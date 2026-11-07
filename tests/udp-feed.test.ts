import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeTrackingPacket,
  decodeTrackingPacket,
  trackedSubjectsToPacket,
  type ScreenTrackingPacket,
} from '../src/sink/udp-tracking-protocol.js';
import { StreamManager } from '../src/stream/stream-manager.js';
import { PiSpacePusher } from '../src/sink/pispace-pusher.js';
import { FeedManager } from '../src/ingest/feed-manager.js';
import { UdpTrackingPublisher } from '../src/sink/udp-tracking-publisher.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

test('UDP tracking protocol encodes and decodes binary packets accurately', () => {
  const packet: ScreenTrackingPacket = {
    sequence: 105,
    timestampMs: 1730975000000,
    cameraId: 'cam1',
    objects: [
      {
        trackId: 1,
        confidence: 89,
        classId: 0,
        bbox: [0.1234, 0.2345, 0.6789, 0.789],
        velocity: { vx: 0.015, vy: -0.005 },
        label: 'person',
      },
      {
        trackId: 2,
        confidence: 94,
        classId: 0,
        bbox: [0.3, 0.4, 0.8, 0.9],
        velocity: { vx: 0.0, vy: 0.0 },
        label: 'person',
      },
    ],
  };

  const encoded = encodeTrackingPacket(packet);
  assert.ok(encoded.length > 20);

  const decoded = decodeTrackingPacket(encoded);
  assert.ok(decoded);
  assert.equal(decoded.sequence, 105);
  assert.equal(decoded.timestampMs, 1730975000000);
  assert.equal(decoded.cameraId, 'cam1');
  assert.equal(decoded.objects.length, 2);

  // Check object 1
  const obj1 = decoded.objects[0]!;
  assert.equal(obj1.trackId, 1);
  assert.equal(obj1.confidence, 89);
  assert.equal(obj1.classId, 0);
  assert.equal(obj1.label, 'person');
  // Normalized coords within rounding tolerance (1/65535 ~ 0.000015)
  assert.ok(Math.abs(obj1.bbox[0] - 0.1234) < 0.001);
  assert.ok(Math.abs(obj1.bbox[1] - 0.2345) < 0.001);
  assert.ok(Math.abs(obj1.bbox[2] - 0.6789) < 0.001);
  assert.ok(Math.abs(obj1.bbox[3] - 0.789) < 0.001);
  assert.ok(Math.abs((obj1.velocity?.vx ?? 0) - 0.015) < 0.001);
  assert.ok(Math.abs((obj1.velocity?.vy ?? 0) - -0.005) < 0.001);
});

test('UDP tracking protocol handles varying number of feeds (cam2, cam3, etc.) and empty tracks', () => {
  const emptyPacket: ScreenTrackingPacket = {
    sequence: 1,
    timestampMs: 1730975100000,
    cameraId: 'sanctuary-balcony-cam4',
    objects: [],
  };

  const encoded = encodeTrackingPacket(emptyPacket);
  const decoded = decodeTrackingPacket(encoded);
  assert.ok(decoded);
  assert.equal(decoded.cameraId, 'sanctuary-balcony-cam4');
  assert.equal(decoded.objects.length, 0);
});

test('UDP tracking protocol decodes JSON packets gracefully', () => {
  const jsonBuf = Buffer.from(
    JSON.stringify({
      type: 'screen-tracking',
      sequence: 42,
      timestampMs: 1730975200000,
      cameraId: 'cam2',
      objects: [
        {
          trackId: 7,
          confidence: 91,
          bbox: [0.1, 0.2, 0.5, 0.6],
          label: 'person',
        },
      ],
    }),
    'utf8'
  );

  const decoded = decodeTrackingPacket(jsonBuf);
  assert.ok(decoded);
  assert.equal(decoded.cameraId, 'cam2');
  assert.equal(decoded.sequence, 42);
  assert.equal(decoded.objects.length, 1);
  assert.equal(decoded.objects[0]!.trackId, 7);
});

test('FeedManager URL resolution and lifecycle endpoints', async () => {
  const config = loadConfig();
  const pusher = new PiSpacePusher('http://127.0.0.1:9999');
  const streamManager = new StreamManager(pusher, false);
  const feedManager = new FeedManager(streamManager, {
    mediaMtxRtspBaseUrl: 'rtsp://127.0.0.1:8554',
    mediaMtxRtmpBaseUrl: 'rtmp://127.0.0.1:1935',
    fffleetUrl: 'http://127.0.0.1:5000',
  });
  const udpPublisher = new UdpTrackingPublisher({
    host: '127.0.0.1',
    port: 40002,
    enabled: true,
  });

  // URL resolution
  const rtspUrl = feedManager.resolveFeedUrl({
    cameraId: 'cam1',
    sourceType: 'mediamtx',
  });
  assert.equal(rtspUrl, 'rtsp://127.0.0.1:8554/cam1');

  const rtmpUrl = feedManager.resolveFeedUrl({
    cameraId: 'cam2',
    sourceType: 'rtmp',
  });
  assert.equal(rtmpUrl, 'rtmp://127.0.0.1:1935/cam2');

  const explicitUrl = feedManager.resolveFeedUrl({
    cameraId: 'cam3',
    sourceType: 'rtsp',
    url: 'rtsp://192.168.1.100:554/stream1',
  });
  assert.equal(explicitUrl, 'rtsp://192.168.1.100:554/stream1');

  // Fastify app with feed routes
  const app = createServer(streamManager, pusher, config, feedManager, udpPublisher);

  // Setup feeds via HTTP
  const setupRes = await app.inject({
    method: 'POST',
    url: '/api/v1/feeds/setup',
    payload: {
      cameraId: 'cam1',
      name: 'Chancel Pillar',
      sourceType: 'simulation',
      simulationPath: 'altar',
      fps: 10,
    },
  });
  assert.equal(setupRes.statusCode, 200);
  const setupJson = JSON.parse(setupRes.body);
  assert.equal(setupJson.ok, true);
  assert.equal(setupJson.feed.config.cameraId, 'cam1');

  // List feeds
  const listRes = await app.inject({
    method: 'GET',
    url: '/api/v1/feeds',
  });
  assert.equal(listRes.statusCode, 200);
  const feeds = JSON.parse(listRes.body);
  assert.ok(Array.isArray(feeds));
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].config.cameraId, 'cam1');

  // Start feed
  const startRes = await app.inject({
    method: 'POST',
    url: '/api/v1/feeds/cam1/start',
  });
  assert.equal(startRes.statusCode, 200);
  const startJson = JSON.parse(startRes.body);
  assert.equal(startJson.running, true);

  // Feed status is now active
  const activeFeed = feedManager.getFeed('cam1');
  assert.equal(activeFeed?.status, 'active');

  // Stop feed
  const stopRes = await app.inject({
    method: 'POST',
    url: '/api/v1/feeds/cam1/stop',
  });
  assert.equal(stopRes.statusCode, 200);
  assert.equal(activeFeed?.status, 'stopped');

  // Telemetry endpoint
  const telemRes = await app.inject({
    method: 'GET',
    url: '/api/v1/telemetry/udp',
  });
  assert.equal(telemRes.statusCode, 200);
  const telemJson = JSON.parse(telemRes.body);
  assert.equal(telemJson.port, 40002);

  udpPublisher.close();
  await app.close();
});
