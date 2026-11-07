import { EventEmitter } from 'node:events';
import { createFleet } from 'fffleet';
import type { FeedConfig, FeedState, FeedStatus } from '../types.js';
import type { StreamManager } from '../stream/stream-manager.js';

export interface FeedManagerOptions {
  mediaMtxRtspBaseUrl: string;
  mediaMtxRtmpBaseUrl?: string;
  fffleetUrl: string;
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

  constructor(streamManager: StreamManager, options: FeedManagerOptions) {
    super();
    this.streamManager = streamManager;
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
        fps: 10,
        scale: '640:-1',
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
        fps: config.fps ?? 10,
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

    // MediaMTX / RTSP / RTMP ingestion using ff-fleet
    const streamUrl = this.resolveFeedUrl(feed.config);
    const fleetUrl = feed.config.fleetUrl ?? this.fffleetUrl;
    const fps = feed.config.fps ?? 10;
    const scale = feed.config.scale ?? '640:-1';
    const quality = feed.config.quality ?? 3;

    const controller = new AbortController();
    const activeJob: ActiveIngestJob = {
      job: null,
      controller,
      stopped: false,
    };
    this.activeJobs.set(cameraId, activeJob);

    try {
      const fleet = createFleet({ url: fleetUrl });
      const job = await fleet.submit({
        kind: 'stream',
        class: 'stream',
        stdout: true,
        inputs: [{ name: 'src', uri: streamUrl }],
        ffmpeg: {
          args: [
            '-rtsp_transport', 'tcp',
            '-i', '{{input:src}}',
            '-vf', `fps=${fps},scale=${scale}`,
            '-q:v', String(quality),
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            'pipe:1',
          ],
        },
      });

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
      this.consumeMjpegStream(cameraId, job, activeJob).catch((err) => {
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

  private async consumeMjpegStream(
    cameraId: string,
    job: any,
    activeJob: ActiveIngestJob
  ): Promise<void> {
    const feed = this.feeds.get(cameraId);
    let chunkStream: NodeJS.ReadableStream;
    try {
      chunkStream = await job.stdout();
    } catch (err: any) {
      if (!activeJob.stopped) {
        throw new Error(`Failed to attach stdout to ff-fleet job: ${err.message}`);
      }
      return;
    }

    let buffer = Buffer.alloc(0);
    const SOI = Buffer.from([0xff, 0xd8]); // JPEG Start of Image
    const EOI = Buffer.from([0xff, 0xd9]); // JPEG End of Image

    for await (const chunk of chunkStream) {
      if (activeJob.stopped) break;

      buffer = Buffer.concat([buffer, chunk as Buffer]);

      // Scan for JPEG frames in buffer
      while (true) {
        const soiIdx = buffer.indexOf(SOI);
        if (soiIdx === -1) {
          // No start marker found, keep only last byte in case SOI is split
          if (buffer.length > 1) {
            buffer = buffer.subarray(buffer.length - 1);
          }
          break;
        }

        const eoiIdx = buffer.indexOf(EOI, soiIdx + 2);
        if (eoiIdx === -1) {
          // Incomplete frame, slide buffer to soiIdx if leading junk exists
          if (soiIdx > 0) {
            buffer = buffer.subarray(soiIdx);
          }
          // Prevent buffer from growing unbounded
          if (buffer.length > 5 * 1024 * 1024) {
            buffer = Buffer.alloc(0);
          }
          break;
        }

        // Full JPEG frame extracted
        const frameBuf = buffer.subarray(soiIdx, eoiIdx + 2);
        buffer = buffer.subarray(eoiIdx + 2);

        if (feed) {
          feed.framesIngested++;
          feed.lastFrameAtMs = Date.now();
        }

        // Feed directly into ByteTrack & detection engine
        try {
          await this.streamManager.processFrame(cameraId, frameBuf);
        } catch {
          // Frame processing failure ignored per-frame
        }
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
