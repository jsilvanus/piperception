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
import { TRACKING_FLAG_DEGRADED } from '../sink/udp-tracking-protocol.js';
import type { Frame } from '../ingest/frame.js';
import type { FrameConsumer } from '../ingest/frame-hub.js';
import { assessCamera, type CameraView, type GateReason } from '../context/camera-context.js';

export interface PerceptionSettings {
  /** Treat a moving camera as unknown and pause tracking (runtime option, default on). */
  pauseWhileMoving: boolean;
}

/** While nothing changes, an empty or degraded state is re-sent to PiSpace this often. */
const EMPTY_PUSH_INTERVAL_MS = 2000;

function isDetectionsFrame(frame: Frame | Buffer | undefined): frame is Frame {
  return !!frame && !Buffer.isBuffer(frame) && frame.format === 'detections';
}

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
  /** ok: analysing; degraded: the camera context says the picture cannot be trusted. */
  status: 'ok' | 'degraded';
  degradedReasons: GateReason[];
  presetId: number | null;
  trackerResets: number;
  /** Where the last analysed frame's detections came from: this process or a remote fffleet worker. */
  detectionSource: 'local' | 'remote';
  lastPush: { signature: string; atMs: number };
  /** Frame-rate window for frame-driven cameras (frames pushed in through processFrame). */
  fpsWindow: { startMs: number; count: number };
}

/** A frame-driven camera counts as running while frames arrived within this window. */
const FRAME_ALIVE_MS = 3000;

export class StreamManager extends EventEmitter {
  private streams = new Map<string, CameraStreamState>();
  private pusher: PiSpacePusher | null = null;
  private udpPublisher: UdpTrackingPublisher | null = null;
  private autoPush = true;
  private defaultDetector: DetectorBackend | null = null;
  private contextSource: ((cameraId: string) => CameraView | null) | null = null;
  readonly settings: PerceptionSettings = { pauseWhileMoving: true };

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

  /** Detector for real (non-simulation) cameras; existing real streams switch to it. */
  setDefaultDetector(detector: DetectorBackend): void {
    this.defaultDetector = detector;
    for (const s of this.streams.values()) {
      if (s.config.sourceType !== 'simulation') s.detector = detector;
    }
  }

  /** Where camera context (picam) comes from. Without one, real cameras are never gated. */
  setContextSource(source: ((cameraId: string) => CameraView | null) | null): void {
    this.contextSource = source;
  }

  updateSettings(patch: Partial<PerceptionSettings>): PerceptionSettings {
    if (typeof patch.pauseWhileMoving === 'boolean') this.settings.pauseWhileMoving = patch.pauseWhileMoving;
    return { ...this.settings };
  }

  /** The person pipeline as a FrameHub consumer: every camera that has a stream here. */
  asFrameConsumer(): FrameConsumer {
    return {
      name: 'person',
      wants: (cameraId) => this.streams.has(cameraId),
      handle: async (frame) => {
        await this.processFrame(frame.cameraId, frame);
      },
    };
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
      streamDetector = this.defaultDetector ?? new StubDetector();
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
      status: 'ok',
      degradedReasons: [],
      presetId: null,
      trackerResets: 0,
      detectionSource: 'local',
      lastPush: { signature: '', atMs: 0 },
      fpsWindow: { startMs: 0, count: 0 },
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
        void this.maybePush(stream, tracks, now);
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

  /**
   * Runs one frame through gating, detection and tracking. A real camera whose context says the picture
   * cannot be trusted (stale, privacy blur, moving while pauseWhileMoving, frozen, picam unreachable) is
   * not analysed: it reports status 'degraded' with an empty list, which means "unknown", not "nobody".
   * The tracker is reset when analysis resumes and when the preset changes, so IDs do not jump across views.
   */
  async processFrame(cameraId: string, frame?: Frame | Buffer): Promise<CameraFrameDetection | null> {
    const stream = this.streams.get(cameraId);
    if (!stream) return null;

    const t0 = performance.now();
    const now = Date.now();

    const gated = stream.config.sourceType !== 'simulation' && this.contextSource !== null;
    const gate = gated
      ? assessCamera(this.contextSource!(cameraId), { pauseWhileMoving: this.settings.pauseWhileMoving })
      : { state: 'ok' as const, reasons: [] as GateReason[], presetId: null };

    let tracks: TrackedSubject[];
    if (gate.state === 'unknown') {
      if (stream.status !== 'degraded') {
        stream.tracker.reset();
        stream.trackerResets++;
      }
      stream.status = 'degraded';
      stream.degradedReasons = gate.reasons;
      tracks = [];
    } else {
      // Entering 'degraded' already reset the tracker. A preset change without a reported move is
      // still a different view, so reset then too.
      if (stream.status === 'ok' && gated && gate.presetId !== stream.presetId) {
        stream.tracker.reset();
        stream.trackerResets++;
      }
      stream.status = 'ok';
      stream.degradedReasons = [];
      const remote = isDetectionsFrame(frame);
      stream.detectionSource = remote ? 'remote' : 'local';
      const rawDets = remote ? (frame.detections ?? []) : await stream.detector.detect(frame);
      tracks = stream.tracker.update(rawDets, now);
    }
    stream.presetId = gate.presetId;

    stream.activeTracks = tracks;
    stream.frameIndex++;
    stream.lastFrameTimeMs = now;
    stream.lastProcessingLatencyMs = Math.round((performance.now() - t0) * 10) / 10;
    countFrame(stream, now);

    const event: CameraFrameDetection = {
      cameraId,
      timestamp: new Date().toISOString(),
      frameIndex: stream.frameIndex,
      processingTimeMs: stream.lastProcessingLatencyMs,
      status: stream.status,
      ...(stream.degradedReasons.length ? { reasons: stream.degradedReasons } : {}),
      presetId: stream.presetId,
      objects: tracks.map((t) => ({
        trackId: t.trackId,
        bbox: t.bbox,
        label: t.label,
        confidence: t.confidence,
      })),
    };

    this.emit('detection', event);

    if (this.udpPublisher) {
      this.udpPublisher.sendTracks(cameraId, tracks, now, stream.status === 'degraded' ? TRACKING_FLAG_DEGRADED : 0);
    }

    await this.maybePush(stream, tracks, now);

    return event;
  }

  /** Tracks go to PiSpace on every frame; an empty or degraded state when it changes and then every 2 s. */
  private async maybePush(stream: CameraStreamState, tracks: TrackedSubject[], now: number): Promise<void> {
    if (!this.autoPush || !this.pusher) return;
    const signature = `${stream.status}|${stream.degradedReasons.join(',')}|${stream.presetId}|${tracks.length}`;
    const due =
      tracks.length > 0 ||
      signature !== stream.lastPush.signature ||
      now - stream.lastPush.atMs >= EMPTY_PUSH_INTERVAL_MS;
    if (!due) return;
    stream.lastPush = { signature, atMs: now };
    await this.pusher
      .pushDetections(stream.config.cameraId, tracks, {
        status: stream.status,
        reasons: stream.degradedReasons,
        presetId: stream.presetId,
      })
      .catch(() => false);
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
    detector: string;
    status: 'ok' | 'degraded';
    degradedReasons: GateReason[];
    presetId: number | null;
    trackerResets: number;
    detectionSource: 'local' | 'remote';
  }> {
    const result = [];
    const now = Date.now();
    for (const [cameraId, s] of this.streams.entries()) {
      // A real camera has no timer: frames are pushed in, so it runs while they keep arriving.
      const receiving = s.lastFrameTimeMs > 0 && now - s.lastFrameTimeMs < FRAME_ALIVE_MS;
      result.push({
        cameraId,
        running: s.running || receiving,
        sourceType: s.config.sourceType,
        actualFps: s.running || receiving ? s.actualFps : 0,
        latencyMs: s.lastProcessingLatencyMs,
        frameIndex: s.frameIndex,
        trackCount: s.activeTracks.length,
        activeTracks: s.activeTracks,
        detector: s.detector.name,
        status: s.status,
        degradedReasons: s.degradedReasons,
        presetId: s.presetId,
        trackerResets: s.trackerResets,
        detectionSource: s.detectionSource,
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

/** Frames per second over windows of at least one second, for frames pushed in through processFrame. */
function countFrame(stream: CameraStreamState, now: number): void {
  const w = stream.fpsWindow;
  if (w.startMs === 0 || now - w.startMs > FRAME_ALIVE_MS) {
    w.startMs = now;
    w.count = 0;
    return;
  }
  w.count++;
  const elapsed = now - w.startMs;
  if (elapsed >= 1000) {
    stream.actualFps = Math.round((w.count * 1000 / elapsed) * 10) / 10;
    w.startMs = now;
    w.count = 0;
  }
}
