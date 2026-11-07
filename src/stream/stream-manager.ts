import { EventEmitter } from 'node:events';
import type {
  CameraStreamConfig,
  TrackedSubject,
  CameraFrameDetection,
} from '../types.js';
import { ByteTracker } from '../tracker/bytetrack.js';
import type { DetectorBackend } from '../detector/types.js';
import { SimulationDetector } from '../detector/simulation-backend.js';
import { StubDetector } from '../detector/stub-backend.js';
import { PiSpacePusher } from '../sink/pispace-pusher.js';
import type { UdpTrackingPublisher } from '../sink/udp-tracking-publisher.js';

export interface CameraStreamState {
  config: CameraStreamConfig;
  tracker: ByteTracker;
  detector: DetectorBackend;
  timer: NodeJS.Timeout | null;
  running: boolean;
  frameIndex: number;
  lastFrameTimeMs: number;
  actualFps: number;
  lastProcessingLatencyMs: number;
  activeTracks: TrackedSubject[];
}

export class StreamManager extends EventEmitter {
  private streams = new Map<string, CameraStreamState>();
  private pusher: PiSpacePusher | null = null;
  private udpPublisher: UdpTrackingPublisher | null = null;
  private autoPush = true;

  constructor(pusher?: PiSpacePusher, autoPush = true, udpPublisher?: UdpTrackingPublisher) {
    super();
    this.pusher = pusher ?? null;
    this.autoPush = autoPush;
    this.udpPublisher = udpPublisher ?? null;
  }

  setPusher(pusher: PiSpacePusher): void {
    this.pusher = pusher;
  }

  setUdpPublisher(publisher: UdpTrackingPublisher | null): void {
    this.udpPublisher = publisher;
  }

  /** Register and optionally start a camera stream */
  addStream(config: CameraStreamConfig, detector?: DetectorBackend): CameraStreamState {
    this.removeStream(config.cameraId);

    let streamDetector: DetectorBackend;
    if (detector) {
      streamDetector = detector;
    } else if (config.sourceType === 'simulation') {
      streamDetector = new SimulationDetector(config.simulationPath ?? 'altar');
    } else {
      streamDetector = new StubDetector();
    }

    const tracker = new ByteTracker({
      highScoreThresh: config.confThreshold ?? 0.45,
      matchIoUThresh: config.nmsThreshold ?? 0.25,
    });

    const state: CameraStreamState = {
      config,
      tracker,
      detector: streamDetector,
      timer: null,
      running: false,
      frameIndex: 0,
      lastFrameTimeMs: 0,
      actualFps: 0,
      lastProcessingLatencyMs: 0,
      activeTracks: [],
    };

    this.streams.set(config.cameraId, state);

    if (config.enabled !== false) {
      this.startStream(config.cameraId);
    }

    return state;
  }

  startStream(cameraId: string): boolean {
    const stream = this.streams.get(cameraId);
    if (!stream || stream.running) return false;

    stream.running = true;
    const fps = stream.config.fps ?? 10;
    const intervalMs = Math.max(20, Math.floor(1000 / fps));

    let lastTime = Date.now();

    stream.timer = setInterval(async () => {
      if (!stream.running) return;

      const now = Date.now();
      const delta = now - lastTime;
      lastTime = now;
      if (delta > 0) {
        stream.actualFps = Math.round((1000 / delta) * 10) / 10;
      }

      const t0 = performance.now();
      try {
        const rawDets = await stream.detector.detect();
        const tracks = stream.tracker.update(rawDets, now);
        stream.activeTracks = tracks;
        stream.frameIndex++;
        stream.lastFrameTimeMs = now;
        stream.lastProcessingLatencyMs = Math.round((performance.now() - t0) * 10) / 10;

        const event: CameraFrameDetection = {
          cameraId,
          timestamp: new Date().toISOString(),
          frameIndex: stream.frameIndex,
          processingTimeMs: stream.lastProcessingLatencyMs,
          objects: tracks.map((t) => ({
            trackId: t.trackId,
            bbox: t.bbox,
            label: t.label,
            confidence: t.confidence,
          })),
        };

        this.emit('detection', event);

        // Auto-push to UDP Gateway
        if (this.udpPublisher) {
          this.udpPublisher.sendTracks(cameraId, tracks, now);
        }

        // Auto-push to PiSpace
        if (this.autoPush && this.pusher && tracks.length > 0) {
          this.pusher.pushDetections(cameraId, tracks).catch(() => {});
        }
      } catch (err: any) {
        this.emit('error', { cameraId, error: err.message });
      }
    }, intervalMs);

    return true;
  }

  stopStream(cameraId: string): boolean {
    const stream = this.streams.get(cameraId);
    if (!stream || !stream.running) return false;

    if (stream.timer) {
      clearInterval(stream.timer);
      stream.timer = null;
    }
    stream.running = false;
    return true;
  }

  removeStream(cameraId: string): boolean {
    this.stopStream(cameraId);
    return this.streams.delete(cameraId);
  }

  /** Inject a single frame manually (e.g. from HTTP POST /cameras/:id/frame) */
  async processFrame(cameraId: string, frameBuffer?: Buffer): Promise<CameraFrameDetection | null> {
    const stream = this.streams.get(cameraId);
    if (!stream) return null;

    const t0 = performance.now();
    const now = Date.now();
    const rawDets = await stream.detector.detect(frameBuffer);
    const tracks = stream.tracker.update(rawDets, now);
    stream.activeTracks = tracks;
    stream.frameIndex++;
    stream.lastFrameTimeMs = now;
    stream.lastProcessingLatencyMs = Math.round((performance.now() - t0) * 10) / 10;

    const event: CameraFrameDetection = {
      cameraId,
      timestamp: new Date().toISOString(),
      frameIndex: stream.frameIndex,
      processingTimeMs: stream.lastProcessingLatencyMs,
      objects: tracks.map((t) => ({
        trackId: t.trackId,
        bbox: t.bbox,
        label: t.label,
        confidence: t.confidence,
      })),
    };

    this.emit('detection', event);

    if (this.udpPublisher) {
      this.udpPublisher.sendTracks(cameraId, tracks, now);
    }

    if (this.autoPush && this.pusher && tracks.length > 0) {
      await this.pusher.pushDetections(cameraId, tracks);
    }

    return event;
  }

  getStream(cameraId: string): CameraStreamState | undefined {
    return this.streams.get(cameraId);
  }

  getAllStreams(): Array<{
    cameraId: string;
    running: boolean;
    sourceType: string;
    actualFps: number;
    latencyMs: number;
    frameIndex: number;
    trackCount: number;
    activeTracks: TrackedSubject[];
  }> {
    const result = [];
    for (const [cameraId, s] of this.streams.entries()) {
      result.push({
        cameraId,
        running: s.running,
        sourceType: s.config.sourceType,
        actualFps: s.actualFps,
        latencyMs: s.lastProcessingLatencyMs,
        frameIndex: s.frameIndex,
        trackCount: s.activeTracks.length,
        activeTracks: s.activeTracks,
      });
    }
    return result;
  }

  stopAll(): void {
    for (const cameraId of this.streams.keys()) {
      this.stopStream(cameraId);
    }
  }
}
