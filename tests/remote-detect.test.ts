import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { FeedManager } from '../src/ingest/feed-manager.js';
import { FrameHub } from '../src/ingest/frame-hub.js';
import type { Frame } from '../src/ingest/frame.js';
import { StreamManager } from '../src/stream/stream-manager.js';
import {
  DETECT_JOB_TYPE,
  DetectLineReader,
  buildDetectJobSpec,
  encodeFrameLine,
  encodeHelloLine,
  frameLineDetections,
  readDetectPayload,
} from '../src/fleet/detect-protocol.js';
import { runDetect } from '../src/fleet/detect-executor.js';

const person = (x: number) => ({ rect: { x, y: 0.2, w: 0.1, h: 0.5 }, score: 0.9, classIndex: 0, label: 'person' });

test('detect lines survive a round trip split across chunks', () => {
  const text = encodeHelloLine('yolox_tiny', ['cpu']) + encodeFrameLine(1000, 12.34, [person(0.1), person(0.5)]) + 'garbage\n';
  const reader = new DetectLineReader();
  const lines = [...reader.push(text.slice(0, 30)), ...reader.push(text.slice(30))];
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.type, 'hello');
  const frame = lines[1]!;
  assert.equal(frame.type, 'frame');
  if (frame.type !== 'frame') return;
  assert.equal(frame.ms, 12.3);
  const dets = frameLineDetections(frame);
  assert.equal(dets.length, 2);
  assert.deepEqual(dets[1]!.rect, { x: 0.5, y: 0.2, w: 0.1, h: 0.5 });
  assert.equal(dets[0]!.label, 'person');
  assert.equal(reader.bad, 1);
});

test('the detect job spec is a stream job of the executor type and validates on the worker side', () => {
  const spec = buildDetectJobSpec({ cameraId: 'cam1', streamUrl: 'rtsp://mediamtx:8554/cam1', workerPreference: ['operator-pc-detect'] });
  assert.equal(spec.type, DETECT_JOB_TYPE);
  assert.equal(spec.kind, 'stream');
  assert.equal(spec.stdout, true);
  assert.deepEqual(spec.workerPreference, ['operator-pc-detect']);
  const p = readDetectPayload(spec);
  assert.equal(p.model, 'yolox_tiny');
  assert.throws(() => readDetectPayload({ [DETECT_JOB_TYPE]: { ...p, model: '../etc/passwd' } }), /model/);
  assert.throws(() => readDetectPayload({ [DETECT_JOB_TYPE]: { ...p, fps: 0 } }), /fps/);
});

interface FakeJobPlan {
  /** ms until the job is placed; undefined = never */
  placeAfterMs?: number;
  stdout: () => Readable;
}

function fakeFleet(opts: { remote: boolean; plans: { remote?: FakeJobPlan[]; local?: FakeJobPlan[] } }) {
  const submitted: any[] = [];
  const cancelled: string[] = [];
  let n = 0;
  const factory = () => ({
    async capabilities() {
      return { capabilities: opts.remote ? ['normal', `type:${DETECT_JOB_TYPE}`] : ['normal'] };
    },
    async submit(spec: any) {
      submitted.push(spec);
      const isRemote = spec.type === DETECT_JOB_TYPE;
      const plan = (isRemote ? opts.plans.remote : opts.plans.local)?.shift() ?? { placeAfterMs: 1, stdout: () => new PassThrough() };
      const job: any = new EventEmitter();
      job.id = `job_${++n}`;
      job.state = 'queued';
      job.variant = null;
      job.workerId = isRemote ? 'operator-pc-detect' : 'pi';
      job.cancel = async () => void cancelled.push(job.id);
      if (plan.placeAfterMs !== undefined) {
        setTimeout(() => {
          job.state = 'running';
          job.emit('event', { state: 'running', variant: null });
        }, plan.placeAfterMs);
      }
      job.stdout = async () => plan.stdout();
      return job;
    },
  });
  return { factory, submitted, cancelled };
}

function setup(fleet: ReturnType<typeof fakeFleet>, extra: Record<string, unknown> = {}) {
  const hub = new FrameHub();
  const frames: Frame[] = [];
  hub.addConsumer({ name: 'collect', handle: async (f) => void frames.push(f) });
  const fm = new FeedManager(new StreamManager(undefined, false), {
    mediaMtxRtspBaseUrl: 'rtsp://127.0.0.1:8554',
    fffleetUrl: 'http://127.0.0.1:5000',
    hub,
    fleetFactory: fleet.factory,
    localFps: 1,
    remote: { mode: 'auto', placementTimeoutMs: 50, checkIntervalMs: 60_000 },
    ...extra,
  });
  fm.setupFeed({ cameraId: 'cam1', sourceType: 'mediamtx', width: 4, height: 2, fps: 5 });
  return { fm, hub, frames };
}

const until = async (cond: () => boolean, ms = 1000) => {
  for (let t = 0; t < ms && !cond(); t += 5) await new Promise((r) => setTimeout(r, 5));
};

test('a camera uses the remote worker when one offers perception-detect', async () => {
  const lines = encodeHelloLine('yolox_tiny', ['cpu']) + encodeFrameLine(1, 20, [person(0.3)]);
  const fleet = fakeFleet({ remote: true, plans: { remote: [{ placeAfterMs: 1, stdout: () => { const s = new PassThrough(); s.write(lines); return s; } }] } });
  const { fm, frames, hub } = setup(fleet);
  assert.equal(await fm.startFeed('cam1'), true);
  await until(() => frames.length > 0);
  await hub.idle();
  assert.equal(fleet.submitted.length, 1);
  assert.equal(fleet.submitted[0].type, DETECT_JOB_TYPE);
  const feed = fm.getFeed('cam1')!;
  assert.equal(feed.detection, 'remote');
  assert.equal(feed.remoteModel, 'yolox_tiny');
  assert.equal(frames[0]!.format, 'detections');
  assert.equal(frames[0]!.detections!.length, 1);
  await fm.stopAll();
});

test('without a remote worker the camera uses the local feed, capped to the local rate', async () => {
  const fleet = fakeFleet({ remote: false, plans: {} });
  const { fm } = setup(fleet);
  assert.equal(await fm.startFeed('cam1'), true);
  assert.equal(fleet.submitted.length, 1);
  assert.equal(fleet.submitted[0].type, undefined);
  assert.match(fleet.submitted[0].ffmpeg.args.join(' '), /fps=1,/);
  assert.equal(fm.getFeed('cam1')!.detection, 'local');
  await fm.stopAll();
});

test('a remote job nobody takes is cancelled and the camera goes local', async () => {
  const fleet = fakeFleet({ remote: true, plans: { remote: [{ placeAfterMs: undefined, stdout: () => new PassThrough() }] } });
  const { fm } = setup(fleet);
  assert.equal(await fm.startFeed('cam1'), true);
  assert.equal(fleet.submitted.length, 2);
  assert.equal(fleet.cancelled[0], 'job_1');
  const feed = fm.getFeed('cam1')!;
  assert.equal(feed.detection, 'local');
  assert.match(feed.remoteError ?? '', /no worker took/);
  await fm.stopAll();
});

test('when the remote job ends the camera falls back to local, and moves back once a worker is there', async () => {
  let t = 1_000_000;
  const remoteOut = new PassThrough();
  const fleet = fakeFleet({
    remote: true,
    plans: {
      remote: [
        { placeAfterMs: 1, stdout: () => remoteOut },
        { placeAfterMs: 1, stdout: () => new PassThrough() },
      ],
    },
  });
  const { fm } = setup(fleet, { now: () => t });
  await fm.startFeed('cam1');
  assert.equal(fm.getFeed('cam1')!.detection, 'remote');
  remoteOut.end(); // the operator PC went away
  await until(() => fleet.submitted.length === 2);
  assert.equal(fleet.submitted[1].type, undefined, 'local feed started');
  assert.equal(fm.getFeed('cam1')!.detection, 'local');

  await fm.checkRemote();
  assert.equal(fleet.submitted.length, 2, 'no retry before the back-off');
  t += 61_000;
  await fm.checkRemote();
  assert.equal(fleet.submitted.length, 3);
  assert.equal(fleet.submitted[2].type, DETECT_JOB_TYPE);
  assert.equal(fm.getFeed('cam1')!.detection, 'remote');
  assert.ok(fleet.cancelled.includes('job_2'), 'local job stopped once remote runs');
  await fm.stopAll();
});

test('a detections frame skips the local detector but is still tracked', async () => {
  const sm = new StreamManager(undefined, false);
  let called = 0;
  sm.setDefaultDetector({ name: 'spy', detect: async () => (called++, []) });
  sm.addStream({ cameraId: 'cam1', sourceType: 'rtsp' });
  const frame: Frame = { cameraId: 'cam1', tsMs: 1, format: 'detections', width: 640, height: 480, data: Buffer.alloc(0), detections: [person(0.4)] };
  for (let i = 0; i < 3; i++) await sm.processFrame('cam1', frame);
  assert.equal(called, 0);
  const s = sm.getAllStreams()[0]!;
  assert.equal(s.detectionSource, 'remote');
  assert.equal(s.trackCount, 1);
  sm.stopAll();
});

test('the executor turns ffmpeg frames into detect lines and stops on abort', async () => {
  const w = 32, h = 32;
  const ff = new EventEmitter() as any;
  ff.stdout = new PassThrough();
  ff.stderr = new PassThrough();
  ff.kill = () => {
    ff.stdout.end();
    setTimeout(() => ff.emit('close', null), 1);
  };
  let attached: PassThrough | null = null;
  const abort = new AbortController();
  const spec = buildDetectJobSpec({ cameraId: 'cam1', streamUrl: 'rtsp://mediamtx:8554/cam1', width: w, height: h });
  let args: string[] = [];
  const done = runDetect(
    spec,
    { signal: abort.signal, attachStdout: (s) => void (attached = s as PassThrough) },
    {
      detectorFor: async () => ({ detector: { name: 'fake', detect: async () => [person(0.25)] }, providers: ['cpu'] }),
      spawnFfmpeg: (_c, a) => ((args = a), ff),
    },
  );
  await until(() => attached !== null);
  ff.stdout.write(Buffer.alloc(w * h * 3 * 2, 7));
  const reader = new DetectLineReader();
  const got: any[] = [];
  attached!.on('data', (c: Buffer) => got.push(...reader.push(c)));
  await until(() => got.length >= 2);
  abort.abort(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
  await assert.rejects(done, /cancelled/);
  assert.ok(args.includes('rtsp://mediamtx:8554/cam1'));
  assert.ok(args.includes(`fps=5,scale=${w}:${h}`));
  assert.equal(got[0].type, 'hello');
  assert.equal(got[1].type, 'frame');
  assert.equal(got[1].d.length, 1);
});

test('the executor refuses specs it should not run', async () => {
  const rt = { signal: new AbortController().signal };
  const deps = { detectorFor: async () => ({ detector: { name: 'x', detect: async () => [] }, providers: [] }) };
  const spec = buildDetectJobSpec({ cameraId: 'c', streamUrl: 'file:///etc/passwd' });
  await assert.rejects(runDetect(spec, rt, deps), /not allowed/);
  await assert.rejects(runDetect({ type: DETECT_JOB_TYPE }, rt, deps), /required/);
});
