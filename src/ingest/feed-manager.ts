import { EventEmitter } from 'node:events';
import { createFleet } from 'fffleet';
import type { FeedConfig, FeedState } from '../types.js';
import type { StreamManager } from '../stream/stream-manager.js';
import { FrameHub } from './frame-hub.js';
import { MjpegSplitter, RawFrameSplitter, type FrameFormat } from './frame.js';
import { buildFeedJobSpec, formatForVariant, sniffFormat, waitForVariant } from './fleet-feed-spec.js';
import {
  DETECT_JOB_TYPE,
  DEFAULT_REMOTE_MODEL,
  DetectLineReader,
  buildDetectJobSpec,
  frameLineDetections,
} from '../fleet/detect-protocol.js';

const EMPTY = Buffer.alloc(0);

/** The MediaMTX analysis streams are 640x480 at 5 fps; ask for exactly that. */
export const DEFAULT_FEED_FPS = 5;
export const DEFAULT_FEED_WIDTH = 640;
export const DEFAULT_FEED_HEIGHT = 480;

type FleetFactory = (opts: { url: string; token?: string; clientId?: string; clientSecret?: string }) => {
  submit(spec: any): Promise<any>;
  capabilities?(): Promise<Record<string, unknown>>;
};

/**
 * Remote detection: when a fleet worker offers job type `perception-detect` (e.g. the operator PC), the
 * camera is read and analysed there and only detections come back. Otherwise, or when that job fails,
 * the camera falls back to the local feed (frames to this process, detection here).
 */
export interface RemoteDetectOptions {
  /** auto (default): use a remote worker when one is there; off: always local. */
  mode?: 'auto' | 'off' | undefined;
  model?: string | undefined;
  inputSize?: number | undefined;
  channelOrder?: 'bgr' | 'rgb' | undefined;
  workerPreference?: string[] | undefined;
  requires?: string[] | undefined;
  /** How often local cameras look for a remote worker again (default 30 s). */
  checkIntervalMs?: number | undefined;
  /** A remote job not placed on a worker within this time is cancelled (default 10 s). */
  placementTimeoutMs?: number | undefined;
  /** Longest wait before trying remote again after failures (default 5 min). */
  maxBackoffMs?: number | undefined;
}

interface RemoteState {
  failures: number;
  nextTryAtMs: number;
}

export interface FeedManagerOptions {
  mediaMtxRtspBaseUrl: string;
  mediaMtxRtmpBaseUrl?: string;
  mediaMtxApiUrl?: string | undefined;
  fffleetUrl: string;
  fffleetToken?: string | undefined;
  fffleetClientId?: string | undefined;
  fffleetClientSecret?: string | undefined;
  /** Workers that send MJPEG instead of raw frames (default: none). */
  mjpegWorkers?: string[] | undefined;
  workerPreference?: string[] | undefined;
  requires?: string[] | undefined;
  /** Frames go here; a new hub is made when not given. */
  hub?: FrameHub | undefined;
  /** For tests: replaces fffleet's createFleet. */
  fleetFactory?: FleetFactory | undefined;
  placementTimeoutMs?: number | undefined;
  remote?: RemoteDetectOptions | undefined;
  /** Cap on the frame rate of the local feed (detection in this process), e.g. 1 on a Pi. */
  localFps?: number | undefined;
  /** For tests: clock. */
  now?: (() => number) | undefined;
}

interface ActiveIngestJob {
  job: any;
  controller: AbortController;
  stopped: boolean;
}

export class FeedManager extends EventEmitter {
  private feeds = new Map<string, FeedState>();
  private activeJobs = new Map<string, ActiveIngestJob>();
  private remoteJobs = new Map<string, ActiveIngestJob>();
  private remoteState = new Map<string, RemoteState>();
  private remoteTimer: NodeJS.Timeout | null = null;
  private capsCache: { atMs: number; available: boolean } | null = null;
  private readonly remote: Required<Omit<RemoteDetectOptions, 'workerPreference' | 'requires'>> &
    Pick<RemoteDetectOptions, 'workerPreference' | 'requires'>;
  private readonly now: () => number;
  private readonly localFps: number | undefined;
  private readonly streamManager: StreamManager;
  private readonly mediaMtxRtspBaseUrl: string;
  private readonly mediaMtxRtmpBaseUrl: string;
  private readonly mediaMtxApiUrl: string | undefined;
  private readonly fffleetUrl: string;
  private readonly fleetAuth: { token?: string; clientId?: string; clientSecret?: string };
  private readonly mjpegWorkers: string[];
  private readonly workerPreference: string[] | undefined;
  private readonly requires: string[] | undefined;
  private readonly fleetFactory: FleetFactory;
  private readonly placementTimeoutMs: number;
  readonly hub: FrameHub;

  constructor(streamManager: StreamManager, options: FeedManagerOptions) {
    super();
    this.streamManager = streamManager;
    this.hub = options.hub ?? new FrameHub();
    this.fleetFactory = options.fleetFactory ?? (createFleet as unknown as FleetFactory);
    this.fleetAuth = {
      ...(options.fffleetToken ? { token: options.fffleetToken } : {}),
      ...(options.fffleetClientId && options.fffleetClientSecret
        ? { clientId: options.fffleetClientId, clientSecret: options.fffleetClientSecret }
        : {}),
    };
    this.mjpegWorkers = options.mjpegWorkers ?? [];
    this.workerPreference = options.workerPreference;
    this.requires = options.requires;
    this.placementTimeoutMs = options.placementTimeoutMs ?? 5000;
    this.mediaMtxRtspBaseUrl = options.mediaMtxRtspBaseUrl.replace(/\/+$/, '');
    this.mediaMtxRtmpBaseUrl = (options.mediaMtxRtmpBaseUrl ?? 'rtmp://127.0.0.1:1935').replace(/\/+$/, '');
    this.mediaMtxApiUrl = options.mediaMtxApiUrl ? options.mediaMtxApiUrl.replace(/\/+$/, '') : undefined;
    this.fffleetUrl = options.fffleetUrl;
    this.now = options.now ?? Date.now;
    this.localFps = options.localFps && options.localFps > 0 ? options.localFps : undefined;
    const r = options.remote ?? {};
    this.remote = {
      mode: r.mode ?? 'off',
      model: r.model ?? DEFAULT_REMOTE_MODEL,
      inputSize: r.inputSize ?? 416,
      channelOrder: r.channelOrder ?? 'bgr',
      workerPreference: r.workerPreference,
      requires: r.requires,
      checkIntervalMs: r.checkIntervalMs ?? 30_000,
      placementTimeoutMs: r.placementTimeoutMs ?? 10_000,
      maxBackoffMs: r.maxBackoffMs ?? 300_000,
    };
  }

  /**
   * Resolve effective media URL for a feed.
   * If URL is not explicitly given, derives it from MediaMTX conventions:
   *   mediamtx / rtsp -> ${mediaMtxRtspBaseUrl}/${cameraId}
   *   rtmp            -> ${mediaMtxRtmpBaseUrl}/${cameraId}
   */
  resolveFeedUrl(feed: FeedConfig): string {
    if (feed.url?.trim()) {
      return feed.url.trim();
    }
    if (feed.sourceType === 'rtmp') {
      return `${this.mediaMtxRtmpBaseUrl}/${encodeURIComponent(feed.cameraId)}`;
    }
    return `${this.mediaMtxRtspBaseUrl}/${encodeURIComponent(feed.cameraId)}`;
  }

  setupFeed(config: FeedConfig): FeedState {
    const existing = this.feeds.get(config.cameraId);
    if (existing && (existing.status === 'active' || existing.status === 'starting')) {
      this.stopFeed(config.cameraId);
    }

    const state: FeedState = {
      config: {
        fps: DEFAULT_FEED_FPS,
        width: DEFAULT_FEED_WIDTH,
        height: DEFAULT_FEED_HEIGHT,
        quality: 3,
        enabled: true,
        ...config,
      },
      status: 'stopped',
      framesIngested: 0,
      lastFrameAtMs: 0,
    };

    this.feeds.set(config.cameraId, state);

    // Also ensure StreamManager has this camera registered
    if (!this.streamManager.getStream(config.cameraId)) {
      this.streamManager.addStream({
        cameraId: config.cameraId,
        name: config.name ?? config.cameraId,
        sourceType: config.sourceType === 'simulation' ? 'simulation' : 'rtsp',
        fps: config.fps ?? DEFAULT_FEED_FPS,
        enabled: false,
        confThreshold: config.confThreshold ?? 0.45,
        nmsThreshold: config.nmsThreshold ?? 0.25,
        simulationPath: config.simulationPath,
      });
    }

    this.emit('feed:configured', state);
    return state;
  }

  /**
   * Queries MediaMTX REST API to discover incoming stream resolution if available.
   * If detected, updates feed.config.width and feed.config.height.
   */
  async probeResolution(cameraId: string): Promise<{ width: number; height: number } | null> {
    if (!this.mediaMtxApiUrl) return null;
    try {
      const url = `${this.mediaMtxApiUrl}/v3/paths/get/${encodeURIComponent(cameraId)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const data: any = await res.json();
      const tracks = data.tracks2 || [];
      const h264 = tracks.find((t: any) => t.codec === 'H264');
      if (h264?.codecProps?.width && h264?.codecProps?.height) {
        const width = Number(h264.codecProps.width);
        const height = Number(h264.codecProps.height);
        const feed = this.feeds.get(cameraId);
        if (feed) {
          feed.config.width = width;
          feed.config.height = height;
        }
        return { width, height };
      }
      return null;
    } catch {
      return null;
    }
  }

  async startFeed(cameraId: string): Promise<boolean> {
    const feed = this.feeds.get(cameraId);
    if (!feed) return false;
    if (feed.status === 'active' || feed.status === 'starting') return true;

    feed.status = 'starting';
    feed.lastError = undefined;
    this.emit('feed:status', { cameraId, status: feed.status });

    if (feed.config.sourceType === 'simulation') {
      const ok = this.streamManager.startStream(cameraId);
      if (ok) {
        feed.status = 'active';
        this.emit('feed:status', { cameraId, status: feed.status });
        return true;
      }
      feed.status = 'error';
      feed.lastError = 'Failed to start simulation stream in StreamManager';
      this.emit('feed:status', { cameraId, status: feed.status, error: feed.lastError });
      return false;
    }

    this.ensureRemoteWatch();
    await this.probeResolution(cameraId);
    if (await this.shouldTryRemote(cameraId)) {
      if (await this.startRemote(cameraId)) return true;
    }
    return this.startLocal(cameraId);
  }

  /** Local feed: an fffleet stream job sends frames here, the detector of this process analyses them. */
  private async startLocal(cameraId: string): Promise<boolean> {
    const feed = this.feeds.get(cameraId);
    if (!feed) return false;
    if (this.activeJobs.has(cameraId)) return true;
    feed.detection = 'local';
    // MediaMTX / RTSP / RTMP ingestion as an fffleet stream job
    const streamUrl = this.resolveFeedUrl(feed.config);
    const fleetUrl = feed.config.fleetUrl ?? this.fffleetUrl;
    const wantedFps = feed.config.fps ?? DEFAULT_FEED_FPS;
    const fps = this.localFps ? Math.min(wantedFps, this.localFps) : wantedFps;
    const width = feed.config.width ?? DEFAULT_FEED_WIDTH;
    const height = feed.config.height ?? DEFAULT_FEED_HEIGHT;
    const quality = feed.config.quality ?? 3;

    const controller = new AbortController();
    const activeJob: ActiveIngestJob = {
      job: null,
      controller,
      stopped: false,
    };
    this.activeJobs.set(cameraId, activeJob);

    try {
      const fleet = this.fleetFactory({ url: fleetUrl, ...this.fleetAuth });
      const job = await fleet.submit(
        buildFeedJobSpec({
          streamUrl,
          fps,
          width,
          height,
          quality,
          mjpegWorkers: feed.config.mjpegWorkers ?? this.mjpegWorkers,
          workerPreference: feed.config.workerPreference ?? this.workerPreference,
          requires: feed.config.requires ?? this.requires,
        })
      );

      activeJob.job = job;

      // Ensure stream state exists in streamManager
      if (!this.streamManager.getStream(cameraId)) {
        this.streamManager.addStream({
          cameraId,
          name: feed.config.name ?? cameraId,
          sourceType: 'rtsp',
          fps,
          enabled: false,
        });
      }

      feed.status = 'active';
      this.emit('feed:status', { cameraId, status: feed.status, jobId: job.id });

      // Start reader loop asynchronously
      this.consumeStdout(cameraId, job, activeJob, width, height).catch((err) => {
        if (!activeJob.stopped && this.activeJobs.get(cameraId) === activeJob) {
          feed.status = 'error';
          feed.lastError = err.message;
          this.emit('feed:status', { cameraId, status: feed.status, error: err.message });
        }
      });

      return true;
    } catch (err: any) {
      if (activeJob.stopped) return false;
      feed.status = 'error';
      feed.lastError = err.message;
      this.activeJobs.delete(cameraId);
      this.emit('feed:status', { cameraId, status: feed.status, error: err.message });
      return false;
    }
  }

  // ---------------------------------------------------------------- remote detection

  /** Whether some worker of the fleet runs the `perception-detect` executor (cached 5 s). */
  async remoteAvailable(): Promise<boolean> {
    if (this.remote.mode === 'off') return false;
    const now = this.now();
    if (this.capsCache && now - this.capsCache.atMs < 5000) return this.capsCache.available;
    let available = false;
    try {
      const fleet = this.fleetFactory({ url: this.fffleetUrl, ...this.fleetAuth });
      const caps = (await fleet.capabilities?.()) ?? {};
      const list = Array.isArray((caps as any).capabilities) ? ((caps as any).capabilities as unknown[]) : [];
      available = list.includes(`type:${DETECT_JOB_TYPE}`);
    } catch {
      available = false;
    }
    this.capsCache = { atMs: now, available };
    return available;
  }

  private async shouldTryRemote(cameraId: string): Promise<boolean> {
    const feed = this.feeds.get(cameraId);
    if (!feed || feed.config.sourceType === 'simulation' || this.remote.mode === 'off') return false;
    if (feed.config.remoteDetect === false) return false;
    const st = this.remoteState.get(cameraId);
    if (st && this.now() < st.nextTryAtMs) return false;
    return this.remoteAvailable();
  }

  private remoteFailed(cameraId: string, reason: string): void {
    const st = this.remoteState.get(cameraId) ?? { failures: 0, nextTryAtMs: 0 };
    st.failures++;
    const wait = Math.min(this.remote.maxBackoffMs, this.remote.checkIntervalMs * 2 ** (st.failures - 1));
    st.nextTryAtMs = this.now() + wait;
    this.remoteState.set(cameraId, st);
    const feed = this.feeds.get(cameraId);
    if (feed) feed.remoteError = reason;
    this.capsCache = null;
    this.emit('feed:remote', { cameraId, state: 'failed', error: reason, retryInMs: wait });
  }

  /**
   * Starts a `perception-detect` job for the camera. Returns false (and the caller stays or goes local)
   * when it is not placed within placementTimeoutMs or cannot be submitted. Once it runs, a running local
   * job of the camera is stopped; when the remote job ends, the camera goes back to the local feed.
   */
  private async startRemote(cameraId: string): Promise<boolean> {
    const feed = this.feeds.get(cameraId);
    if (!feed) return false;
    if (this.remoteJobs.has(cameraId)) return true;
    const active: ActiveIngestJob = { job: null, controller: new AbortController(), stopped: false };
    this.remoteJobs.set(cameraId, active);
    const spec = buildDetectJobSpec({
      cameraId,
      streamUrl: this.resolveFeedUrl(feed.config),
      fps: feed.config.fps ?? DEFAULT_FEED_FPS,
      width: feed.config.width ?? DEFAULT_FEED_WIDTH,
      height: feed.config.height ?? DEFAULT_FEED_HEIGHT,
      model: this.remote.model,
      inputSize: this.remote.inputSize,
      channelOrder: this.remote.channelOrder,
      confThreshold: feed.config.confThreshold,
      nmsThreshold: feed.config.nmsThreshold,
      workerPreference: this.remote.workerPreference,
      requires: this.remote.requires,
    });
    try {
      const fleet = this.fleetFactory({ url: feed.config.fleetUrl ?? this.fffleetUrl, ...this.fleetAuth });
      const job = await fleet.submit(spec);
      active.job = job;
      const placed = await waitForVariant(job, this.remote.placementTimeoutMs);
      if (placed === undefined) {
        throw new Error(`no worker took the detection job within ${this.remote.placementTimeoutMs} ms`);
      }
      if (active.stopped) return false;
      const stdout = await job.stdout();
      feed.detection = 'remote';
      feed.remoteJobId = job.id;
      feed.remoteWorker = job.workerId ?? job.snapshot?.workerId ?? null;
      feed.remoteError = undefined;
      feed.status = 'active';
      this.remoteState.delete(cameraId);
      this.emit('feed:remote', { cameraId, state: 'running', jobId: job.id });
      this.emit('feed:status', { cameraId, status: feed.status, jobId: job.id, detection: 'remote' });
      await this.stopLocal(cameraId);
      void this.consumeRemote(cameraId, stdout, active);
      return true;
    } catch (err: any) {
      this.remoteJobs.delete(cameraId);
      if (active.job?.cancel) await active.job.cancel().catch(() => undefined);
      if (!active.stopped) this.remoteFailed(cameraId, err?.message ?? String(err));
      return false;
    }
  }

  private async consumeRemote(cameraId: string, stdout: AsyncIterable<Buffer>, active: ActiveIngestJob): Promise<void> {
    const feed = this.feeds.get(cameraId);
    const reader = new DetectLineReader();
    const width = feed?.config.width ?? DEFAULT_FEED_WIDTH;
    const height = feed?.config.height ?? DEFAULT_FEED_HEIGHT;
    let error: string | undefined;
    try {
      for await (const chunk of stdout) {
        if (active.stopped) break;
        for (const line of reader.push(chunk as Buffer)) {
          if (line.type === 'hello') {
            if (feed) feed.remoteModel = line.model;
            continue;
          }
          const now = this.now();
          if (feed) {
            feed.framesIngested++;
            feed.lastFrameAtMs = now;
            feed.remoteInferenceMs = line.ms;
          }
          this.hub.publish({ cameraId, tsMs: now, format: 'detections', width, height, data: EMPTY, detections: frameLineDetections(line) });
        }
      }
    } catch (err: any) {
      error = err?.message ?? String(err);
    }
    if (active.stopped || this.remoteJobs.get(cameraId) !== active) return;
    this.remoteJobs.delete(cameraId);
    const snap = active.job?.snapshot;
    const reason = error ?? snap?.error?.message ?? `remote detection job ended (${snap?.state ?? active.job?.state ?? 'unknown'})`;
    this.remoteFailed(cameraId, reason);
    if (feed) {
      feed.detection = 'local';
      feed.remoteJobId = undefined;
      feed.remoteWorker = undefined;
    }
    // Fall back to the local feed straight away.
    if (feed && feed.status !== 'stopped') await this.startLocal(cameraId);
  }

  private async stopLocal(cameraId: string): Promise<void> {
    const activeJob = this.activeJobs.get(cameraId);
    if (!activeJob) return;
    activeJob.stopped = true;
    activeJob.controller.abort();
    this.activeJobs.delete(cameraId);
    if (activeJob.job && typeof activeJob.job.cancel === 'function') {
      await activeJob.job.cancel().catch(() => undefined);
    }
  }

  private async stopRemote(cameraId: string): Promise<void> {
    const active = this.remoteJobs.get(cameraId);
    if (!active) return;
    active.stopped = true;
    active.controller.abort();
    this.remoteJobs.delete(cameraId);
    if (active.job && typeof active.job.cancel === 'function') {
      await active.job.cancel().catch(() => undefined);
    }
  }

  /** Every checkIntervalMs: cameras on the local feed move to a remote worker when one has come up. */
  private ensureRemoteWatch(): void {
    if (this.remoteTimer || this.remote.mode === 'off') return;
    this.remoteTimer = setInterval(() => void this.checkRemote(), this.remote.checkIntervalMs);
    this.remoteTimer.unref?.();
  }

  /** One pass of the remote watch (public for tests). */
  async checkRemote(): Promise<void> {
    for (const [cameraId, feed] of this.feeds) {
      if (feed.status !== 'active' || feed.detection === 'remote' || this.remoteJobs.has(cameraId)) continue;
      if (await this.shouldTryRemote(cameraId)) await this.startRemote(cameraId);
    }
  }

  /**
   * Reads the job's stdout and publishes frames to the hub. The bytes are rawvideo rgb24 or MJPEG
   * depending on the spec variant fffleet chose for the worker, so the variant is read first.
   */
  private async consumeStdout(
    cameraId: string,
    job: any,
    activeJob: ActiveIngestJob,
    width: number,
    height: number
  ): Promise<void> {
    const feed = this.feeds.get(cameraId);
    let chunkStream: AsyncIterable<Buffer>;
    try {
      chunkStream = await job.stdout();
    } catch (err: any) {
      if (!activeJob.stopped) {
        throw new Error(`Failed to attach stdout to fffleet job: ${err.message}`);
      }
      return;
    }

    const variant = await waitForVariant(job, this.placementTimeoutMs);
    let format: FrameFormat | null = variant === undefined ? null : formatForVariant(variant);
    let split: ((chunk: Buffer) => Buffer[]) | null = null;
    const choose = (fmt: FrameFormat) => {
      format = fmt;
      if (feed) {
        feed.format = fmt;
        feed.variant = variant ?? null;
      }
      if (fmt === 'jpeg') {
        const s = new MjpegSplitter();
        split = (c) => s.push(c);
      } else {
        const s = new RawFrameSplitter(width, height);
        split = (c) => s.push(c);
      }
    };
    if (format) choose(format);

    for await (const chunk of chunkStream) {
      if (activeJob.stopped) break;
      if (!split) choose(sniffFormat(chunk as Buffer));
      for (const data of split!(chunk as Buffer)) {
        const now = Date.now();
        if (feed) {
          feed.framesIngested++;
          feed.lastFrameAtMs = now;
        }
        this.hub.publish({ cameraId, tsMs: now, format: format!, width, height, data });
      }
    }

    if (!activeJob.stopped && feed && feed.status === 'active') {
      feed.status = 'stopped';
      this.emit('feed:status', { cameraId, status: 'stopped' });
    }
  }

  async stopFeed(cameraId: string): Promise<boolean> {
    const feed = this.feeds.get(cameraId);
    if (!feed) return false;

    feed.status = 'stopped';
    await this.stopRemote(cameraId);
    await this.stopLocal(cameraId);
    feed.detection = undefined;
    feed.remoteJobId = undefined;
    feed.remoteWorker = undefined;

    if (feed.config.sourceType === 'simulation') {
      this.streamManager.stopStream(cameraId);
    }

    feed.status = 'stopped';
    this.emit('feed:status', { cameraId, status: 'stopped' });
    return true;
  }

  async startAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [id, feed] of this.feeds.entries()) {
      if (feed.config.enabled !== false) {
        results[id] = await this.startFeed(id);
      }
    }
    return results;
  }

  async stopAll(): Promise<void> {
    if (this.remoteTimer) clearInterval(this.remoteTimer);
    this.remoteTimer = null;
    for (const id of this.feeds.keys()) {
      await this.stopFeed(id);
    }
  }

  getFeed(cameraId: string): FeedState | undefined {
    return this.feeds.get(cameraId);
  }

  getAllFeeds(): FeedState[] {
    return Array.from(this.feeds.values());
  }
}
