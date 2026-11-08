import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { assessCamera, type CameraContext, type CameraView } from '../src/context/camera-context.js';
import { CameraContextClient } from '../src/context/camera-context-client.js';
import { StreamManager } from '../src/stream/stream-manager.js';
import { StubDetector } from '../src/detector/stub-backend.js';
import { decodeTrackingPacket, TRACKING_FLAG_DEGRADED } from '../src/sink/udp-tracking-protocol.js';

const ctx = (over: Partial<CameraContext> = {}): CameraContext => ({
  cameraId: 'cam1', presetId: 1, targetPresetId: null, moving: false, settled: true, ptz: null,
  privacyBlur: false, focusMode: 'auto', updatedAt: new Date().toISOString(), stale: false, ...over,
});
const view = (c: CameraContext | null, over: Partial<CameraView> = {}): CameraView => ({ context: c, health: 'ok', connected: true, ...over });

test('assessCamera: stale, blur, moving, frozen, missing context and no link are unknown', () => {
  const on = { pauseWhileMoving: true };
  assert.equal(assessCamera(view(ctx()), on).state, 'ok');
  assert.deepEqual(assessCamera(view(ctx({ stale: true })), on).reasons, ['stale']);
  assert.deepEqual(assessCamera(view(ctx({ privacyBlur: true })), on).reasons, ['privacy-blur']);
  assert.deepEqual(assessCamera(view(ctx({ moving: true })), on).reasons, ['moving']);
  assert.deepEqual(assessCamera(view(ctx({ targetPresetId: 3 })), on).reasons, ['moving']);
  assert.deepEqual(assessCamera(view(ctx(), { health: 'frozen' }), on).reasons, ['frozen']);
  assert.deepEqual(assessCamera(view(null), on).reasons, ['no-context']);
  assert.ok(assessCamera(view(ctx(), { connected: false }), on).reasons.includes('picam-unreachable'));
  assert.ok(assessCamera(null, on).reasons.includes('picam-unreachable'));
  // degraded health is not enough to stop analysis
  assert.equal(assessCamera(view(ctx(), { health: 'degraded' }), on).state, 'ok');
  // pause-while-moving off: moving is analysed
  assert.equal(assessCamera(view(ctx({ moving: true })), { pauseWhileMoving: false }).state, 'ok');
});

test('StreamManager gates frames, resets the tracker, flags UDP and pushes empty sets', async () => {
  const pushes: any[] = [];
  const pusher: any = { pushDetections: async (id: string, tracks: any[], meta: any) => void pushes.push({ id, n: tracks.length, ...meta }) };
  const udp: Buffer[] = [];
  const publisher: any = {
    sendTracks: (id: string, tracks: any[], ts: number, flags: number) => {
      udp.push(Buffer.from(JSON.stringify({ id, n: tracks.length, flags })));
      return true;
    },
  };
  const sm = new StreamManager(pusher, true, publisher);
  const person = { rect: { x: 0.4, y: 0.3, w: 0.1, h: 0.4 }, score: 0.9, classIndex: 0, label: 'person' };
  const detector = new StubDetector([person]);
  sm.setDefaultDetector(detector);
  let current: CameraView = view(ctx());
  sm.setContextSource(() => current);
  sm.addStream({ cameraId: 'cam1', sourceType: 'mediamtx', enabled: false });

  await sm.processFrame('cam1');
  const second = await sm.processFrame('cam1');
  assert.equal(second!.status, 'ok');
  assert.equal(second!.objects.length, 1); // confirmed after 2 hits
  const firstId = second!.objects[0]!.trackId;

  current = view(ctx({ moving: true, presetId: null, settled: false }));
  const moving = await sm.processFrame('cam1');
  assert.equal(moving!.status, 'degraded');
  assert.deepEqual(moving!.reasons, ['moving']);
  assert.equal(moving!.objects.length, 0);
  assert.equal(JSON.parse(udp.at(-1)!.toString()).flags, TRACKING_FLAG_DEGRADED);
  assert.equal(pushes.at(-1).status, 'degraded');
  assert.equal(pushes.at(-1).n, 0);

  // Settled on another preset: tracking resumes with fresh IDs.
  current = view(ctx({ presetId: 2 }));
  await sm.processFrame('cam1');
  const resumed = await sm.processFrame('cam1');
  assert.equal(resumed!.status, 'ok');
  assert.equal(resumed!.presetId, 2);
  assert.equal(resumed!.objects[0]!.trackId, firstId); // tracker reset restarts IDs at 1

  // Last person leaves: an empty set is pushed once, not on every frame.
  detector.setDetections([]);
  const before = pushes.length;
  for (let i = 0; i < 20; i++) await sm.processFrame('cam1'); // tracker drops the lost track after a while
  const empties = pushes.slice(before).filter((p) => p.n === 0 && p.status === 'ok');
  assert.equal(empties.length, 1);

  // Runtime option off: moving camera is analysed.
  sm.updateSettings({ pauseWhileMoving: false });
  current = view(ctx({ moving: true }));
  assert.equal((await sm.processFrame('cam1'))!.status, 'ok');
  assert.ok(sm.getStream('cam1')!.trackerResets >= 2);
});

test('degraded flag round-trips in the UDP packet', async () => {
  const { encodeTrackingPacket } = await import('../src/sink/udp-tracking-protocol.js');
  const decoded = decodeTrackingPacket(encodeTrackingPacket({ sequence: 1, timestampMs: 1, cameraId: 'cam1', flags: TRACKING_FLAG_DEGRADED, objects: [] }));
  assert.equal(decoded!.flags, TRACKING_FLAG_DEGRADED);
});

test('CameraContextClient reads context and health, follows SSE and notices a lost link', async () => {
  let current = ctx();
  const sse = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    if (req.url === '/api/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'ready', data: {} })}\n\n`);
      sse.add(res);
      req.on('close', () => sse.delete(res));
      return;
    }
    if (req.url === '/api/v1/cameras/cam1/context') return void res.end(JSON.stringify(current));
    if (req.url === '/api/v1/cameras/cam1/health') return void res.end(JSON.stringify({ cameraId: 'cam1', state: 'ok' }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const client = new CameraContextClient({ baseUrl: `http://127.0.0.1:${port}`, cameraIds: ['cam1'], reconnectMs: 20, pollMs: 30 });
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond());
  };
  try {
    client.start();
    await waitFor(() => client.isConnected && client.getView('cam1')!.context?.presetId === 1);
    assert.equal(client.getView('cam1')!.health, 'ok');

    for (const res of sse) res.write(`data: ${JSON.stringify({ type: 'context', data: ctx({ moving: true, presetId: null }) })}\n\n`);
    await waitFor(() => client.getView('cam1')!.context?.moving === true);
    for (const res of sse) res.write(`data: ${JSON.stringify({ type: 'health', data: { cameraId: 'cam1', state: 'frozen' } })}\n\n`);
    await waitFor(() => client.getView('cam1')!.health === 'frozen');

    // stale is computed by picam on read and not pushed: the poll picks it up
    current = ctx({ stale: true });
    await waitFor(() => client.getView('cam1')!.context?.stale === true);

    for (const res of sse) res.destroy();
    await waitFor(() => !client.getView('cam1')!.connected || !client.isConnected);
    await waitFor(() => client.isConnected); // reconnects
  } finally {
    client.stop();
    for (const res of sse) res.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
