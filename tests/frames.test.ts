import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import jpeg from 'jpeg-js';
import { RawFrameSplitter, MjpegSplitter, type Frame } from '../src/ingest/frame.js';
import { FrameHub } from '../src/ingest/frame-hub.js';
import { buildFeedJobSpec, formatForVariant, MJPEG_VARIANT, sniffFormat, waitForVariant } from '../src/ingest/fleet-feed-spec.js';
import { FeedManager } from '../src/ingest/feed-manager.js';
import { StreamManager } from '../src/stream/stream-manager.js';

test('RawFrameSplitter cuts frames by byte count across uneven chunks', () => {
  const s = new RawFrameSplitter(2, 2); // 12 bytes per frame
  const bytes = Buffer.from(Array.from({ length: 30 }, (_, i) => i));
  const frames = [...s.push(bytes.subarray(0, 5)), ...s.push(bytes.subarray(5, 17)), ...s.push(bytes.subarray(17))];
  assert.equal(frames.length, 2);
  assert.deepEqual([...frames[0]!], [...bytes.subarray(0, 12)]);
  assert.deepEqual([...frames[1]!], [...bytes.subarray(12, 24)]);
  // 6 bytes left over until the next chunk
  assert.equal(s.push(Buffer.alloc(6)).length, 1);
});

test('MjpegSplitter finds JPEGs split over chunks', () => {
  const a = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const b = Buffer.from([0xff, 0xd8, 9, 0xff, 0xd9]);
  const all = Buffer.concat([Buffer.from([7, 7]), a, b]);
  const s = new MjpegSplitter();
  const out = [...s.push(all.subarray(0, 4)), ...s.push(all.subarray(4, 10)), ...s.push(all.subarray(10))];
  assert.equal(out.length, 2);
  assert.deepEqual([...out[0]!], [...a]);
  assert.deepEqual([...out[1]!], [...b]);
});

test('feed spec: rawvideo base, MJPEG variant for listed workers, exact size and fps', () => {
  const spec: any = buildFeedJobSpec({
    streamUrl: 'rtsp://127.0.0.1:8554/cam1', fps: 5, width: 640, height: 480, quality: 3,
    mjpegWorkers: ['operator-pc'], workerPreference: ['operator-pc', 'pi'],
  });
  assert.equal(spec.kind, 'stream');
  assert.equal(spec.stdout, true);
  assert.deepEqual(spec.workerPreference, ['operator-pc', 'pi']);
  const base = spec.ffmpeg.args.join(' ');
  assert.match(base, /-rtsp_transport tcp -i \{\{input:src\}\}/);
  assert.match(base, /fps=5,scale=640:480 -pix_fmt rgb24 -f rawvideo pipe:1$/);
  assert.equal(spec.variants.length, 1);
  assert.equal(spec.variants[0].name, MJPEG_VARIANT);
  assert.deepEqual(spec.variants[0].when, { workers: ['operator-pc'] });
  assert.match(spec.variants[0].ffmpeg.args.join(' '), /-vcodec mjpeg pipe:1$/);
  const noVariants: any = buildFeedJobSpec({ streamUrl: 'rtmp://x/cam1', fps: 5, width: 640, height: 480, quality: 3, mjpegWorkers: [] });
  assert.equal(noVariants.variants, undefined);
  assert.doesNotMatch(noVariants.ffmpeg.args.join(' '), /rtsp_transport/);
});

test('variant -> format, placement wait and byte sniffing', async () => {
  assert.equal(formatForVariant(null), 'rgb24');
  assert.equal(formatForVariant(MJPEG_VARIANT), 'jpeg');
  assert.equal(sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(sniffFormat(Buffer.from([0xff, 0xd8, 0x00])), 'rgb24');

  const job: any = new EventEmitter();
  job.state = 'queued';
  job.variant = null;
  const p = waitForVariant(job, 1000);
  job.emit('event', { state: 'queued', variant: null }); // re-dispatch: not placed yet
  job.emit('event', { state: 'assigned', variant: 'mjpeg' });
  assert.equal(await p, 'mjpeg');

  const unplaced: any = new EventEmitter();
  unplaced.state = 'queued';
  assert.equal(await waitForVariant(unplaced, 20), undefined);

  assert.equal(await waitForVariant({ state: 'running', variant: null }), null);
});

test('FrameHub keeps the newest frame for a busy consumer and drops the rest', async () => {
  const hub = new FrameHub();
  const seen: number[] = [];
  let release!: () => void;
  let gate = new Promise<void>((r) => (release = r));
  hub.addConsumer({
    name: 'slow',
    handle: async (f) => {
      seen.push(f.tsMs);
      await gate;
    },
  });
  const fast: number[] = [];
  hub.addConsumer({ name: 'fast', handle: async (f) => void fast.push(f.tsMs) });
  const frame = (ts: number): Frame => ({ cameraId: 'cam1', tsMs: ts, format: 'rgb24', width: 1, height: 1, data: Buffer.alloc(3) });
  const tick = () => new Promise((r) => setImmediate(r));
  for (const ts of [1, 2, 3, 4]) {
    hub.publish(frame(ts));
    await tick();
  }
  gate = Promise.resolve();
  release();
  await hub.idle();
  assert.deepEqual(seen, [1, 4]);
  assert.deepEqual(fast, [1, 2, 3, 4]);
  assert.equal(hub.stats().consumers.slow!.cam1!.dropped, 2);
  assert.equal(hub.latestFrame('cam1')!.tsMs, 4);
});

function fakeFleet(chunks: Buffer[], variant: string | null) {
  const submitted: any[] = [];
  const factory = () => ({
    async submit(spec: any) {
      submitted.push(spec);
      const job: any = new EventEmitter();
      job.id = 'job_1';
      job.state = 'queued';
      job.variant = null;
      job.cancel = async () => {};
      job.stdout = async () => {
        setTimeout(() => {
          job.state = 'assigned';
          job.variant = variant;
          job.emit('event', { state: 'assigned', variant });
        }, 5);
        return Readable.from(chunks);
      };
      return job;
    },
  });
  return { factory, submitted };
}

async function runFeed(chunks: Buffer[], variant: string | null): Promise<{ frames: Frame[]; spec: any; feed: any }> {
  const hub = new FrameHub();
  const frames: Frame[] = [];
  hub.addConsumer({ name: 'collect', handle: async (f) => void frames.push(f) });
  const { factory, submitted } = fakeFleet(chunks, variant);
  const fm = new FeedManager(new StreamManager(undefined, false), {
    mediaMtxRtspBaseUrl: 'rtsp://127.0.0.1:8554',
    fffleetUrl: 'http://127.0.0.1:5000',
    mjpegWorkers: ['operator-pc'],
    hub,
    fleetFactory: factory,
  });
  fm.setupFeed({ cameraId: 'cam1', sourceType: 'mediamtx', width: 4, height: 2 });
  assert.equal(await fm.startFeed('cam1'), true);
  for (let i = 0; i < 50 && fm.getFeed('cam1')!.status === 'active'; i++) await new Promise((r) => setTimeout(r, 10));
  await hub.idle();
  return { frames, spec: submitted[0], feed: fm.getFeed('cam1') };
}

test('FeedManager parses rawvideo when the job runs as the base spec', async () => {
  const frameBytes = 4 * 2 * 3;
  const data = Buffer.alloc(frameBytes * 2, 0xff); // starts with FF FF: not JPEG either way
  data[0] = 0xff; data[1] = 0xd8; data[2] = 0xff; // looks like JPEG, but the variant says raw
  const { frames, spec, feed } = await runFeed([data.subarray(0, 10), data.subarray(10)], null);
  assert.equal(spec.variants[0].name, 'mjpeg');
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.format, 'rgb24');
  assert.equal(frames[0]!.data.length, frameBytes);
  assert.equal(feed.format, 'rgb24');
});

test('FeedManager parses MJPEG when fffleet chose the mjpeg variant', async () => {
  const img = jpeg.encode({ width: 4, height: 2, data: Buffer.alloc(4 * 2 * 4, 128) }, 90).data;
  const { frames, feed } = await runFeed([Buffer.concat([img, img])], 'mjpeg');
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.format, 'jpeg');
  assert.equal(feed.variant, 'mjpeg');
});

test('FeedManager probeResolution discovers dimensions from mediaMtxApiUrl', async () => {
  const fakeFetch: any = async (url: string) => {
    if (url.includes('/v3/paths/get/cam1')) {
      return {
        ok: true,
        json: async () => ({
          tracks2: [
            { codec: 'H264', codecProps: { width: 960, height: 540 } },
            { codec: 'MPEG-4 Audio' },
          ],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  const fm = new FeedManager(new StreamManager(undefined, false), {
    mediaMtxRtspBaseUrl: 'rtsp://127.0.0.1:8554',
    mediaMtxApiUrl: 'http://127.0.0.1:9997',
    fffleetUrl: 'http://127.0.0.1:5000',
  });
  fm.setupFeed({ cameraId: 'cam1', sourceType: 'mediamtx' });

  // Mock global fetch for probe
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = fakeFetch;
    const probed = await fm.probeResolution('cam1');
    assert.deepEqual(probed, { width: 960, height: 540 });
    const feed = fm.getFeed('cam1');
    assert.equal(feed?.config.width, 960);
    assert.equal(feed?.config.height, 540);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
