import { EventEmitter } from 'node:events';
import { createFleet } from 'fffleet';
import type { FeedConfig, FeedState } from '../types.js';
import type { StreamManager } from '../stream/stream-manager.js';
import { FrameHub } from './frame-hub.js';
import { MjpegSplitter, RawFrameSplitter, type FrameFormat } from './frame.js';
import { buildFeedJobSpec, formatForVariant, sniffFormat, waitForVariant } from './fleet-feed-spec.js';

/** The MediaMTX analysis streams are 640x480 at 5 fps; ask for exactly that. */
export const DEFAULT_FEED_FPS = 5;
export const DEFAULT_FEED_WIDTH = 640;
export const DEFAULT_FEED_HEIGHT = 480;

type FleetFactory = (opts: { url: string; token?: string; clientId?: string; clientSecret?: string }) => {
  submit(spec: any): Promise<any>;
};

export interface FeedManagerOptions {
  mediaMtxRtspBaseUrl: string;
  mediaMtxRtmpBaseUrl?: string;
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
}

interface ActiveIngestJob {
  job: any;
  controller: AbortController;
  stopped: boolean;
}

export class FeedManager extends EventEmitter {
  private feeds = new Map<string, FeedState>();
  private activeJobs = new Map<string, ActiveIngestJob>();
  private readonly streamManager: StreamManager;
  private readonly mediaMtxRtspBaseUrl: string;
  private readonly mediaMtxRtmpBaseUrl: string;
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
    this.fffleetUrl = options.fffleetUrl;
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

    // MediaMTX / RTSP / RTMP ingestion as an fffleet stream job
    const streamUrl = this.resolveFeedUrl(feed.config);
    const fleetUrl = feed.config.fleetUrl ?? this.fffleetUrl;
    const fps = feed.config.fps ?? DEFAULT_FEED_FPS;
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
        if (!activeJob.stopped) {
          feed.status = 'error';
          feed.lastError = err.message;
          this.emit('feed:status', { cameraId, status: feed.status, error: err.message });
        }
      });

      return true;
    } catch (err: any) {
      feed.status = 'error';
      feed.lastError = err.message;
      this.activeJobs.delete(cameraId);
      this.emit('feed:status', { cameraId, status: feed.status, error: err.message });
      return false;
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

    const activeJob = this.activeJobs.get(cameraId);
    if (activeJob) {
      activeJob.stopped = true;
      activeJob.controller.abort();
      if (activeJob.job && typeof activeJob.job.cancel === 'function') {
        try {
          await activeJob.job.cancel();
        } catch {
          // ignore cancel error
        }
      }
      this.activeJobs.delete(cameraId);
    }

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
