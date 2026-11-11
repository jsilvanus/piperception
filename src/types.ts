/**
 * Normalized bounding box [ymin, xmin, ymax, xmax] in range 0.0 to 1.0.
 * Compatible with PiSpace perception ingestion.
 */
export type BoundingBox2D = [ymin: number, xmin: number, ymax: number, xmax: number];

/** Top-left normalized bounding box { x, y, w, h } */
export interface RectBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RawDetection {
  rect: RectBox;
  score: number;
  classIndex: number;
  label: string;
}

export interface TrackedSubject {
  trackId: number;
  bbox: BoundingBox2D; // [ymin, xmin, ymax, xmax]
  rect: RectBox;       // { x, y, w, h }
  confidence: number;
  label: string;
  firstSeen: number;
  lastSeen: number;
  hits: number;
  velocity?: { vx: number; vy: number } | undefined;
}

export interface CameraFrameDetection {
  cameraId: string;
  timestamp: string;
  frameIndex: number;
  processingTimeMs: number;
  /** degraded: the camera picture cannot be trusted now; objects is empty and means "unknown". */
  status?: 'ok' | 'degraded' | undefined;
  reasons?: string[] | undefined;
  presetId?: number | null | undefined;
  objects: Array<{
    trackId: number;
    bbox: BoundingBox2D;
    label: string;
    confidence: number;
  }>;
}

export type StreamSourceType = 'rtsp' | 'rtmp' | 'mediamtx' | 'http' | 'simulation' | 'mock';

export interface FeedConfig {
  cameraId: string;
  name?: string | undefined;
  sourceType: StreamSourceType;
  url?: string | undefined;
  fps?: number | undefined;
  /** Frame size the fleet job scales to (default 640x480). Raw frames are cut by this size. */
  width?: number | undefined;
  height?: number | undefined;
  /** MJPEG quality for the MJPEG variant. */
  quality?: number | undefined;
  fleetUrl?: string | undefined;
  /** fffleet worker IDs that send MJPEG instead of raw rgb24 (overrides PERCEPTION_MJPEG_WORKERS). */
  mjpegWorkers?: string[] | undefined;
  workerPreference?: string[] | undefined;
  requires?: string[] | undefined;
  /** false: never use remote detection for this camera. */
  remoteDetect?: boolean | undefined;
  enabled?: boolean | undefined;
  confThreshold?: number | undefined;
  nmsThreshold?: number | undefined;
  simulationPath?: 'altar' | 'pulpit' | 'lectern' | 'choir' | 'wander' | undefined;
}

export type FeedStatus = 'stopped' | 'starting' | 'active' | 'error';

export interface FeedState {
  config: FeedConfig;
  status: FeedStatus;
  framesIngested: number;
  lastFrameAtMs: number;
  /** Frame format the running job sends (from its fffleet variant). */
  format?: 'rgb24' | 'jpeg' | undefined;
  variant?: string | null | undefined;
  lastError?: string | undefined;
  /** local: frames come here and are analysed here; remote: a fleet worker analyses and sends detections. */
  detection?: 'local' | 'remote' | undefined;
  remoteJobId?: string | undefined;
  remoteWorker?: string | null | undefined;
  remoteModel?: string | undefined;
  remoteInferenceMs?: number | undefined;
  /** Why the last remote attempt failed (the camera is then on the local feed). */
  remoteError?: string | undefined;
}

export interface CameraStreamConfig {
  cameraId: string;
  name?: string | undefined;
  sourceType: StreamSourceType;
  rtspUrl?: string | undefined;
  fps?: number | undefined;
  enabled?: boolean | undefined;
  confThreshold?: number | undefined;
  nmsThreshold?: number | undefined;
  simulationPath?: 'altar' | 'pulpit' | 'lectern' | 'choir' | 'wander' | undefined;
}

export interface AppConfig {
  port: number;
  host: string;
  pispaceUrl: string;
  pigatewayUrl?: string | undefined;
  autoPushPiSpace: boolean;
  defaultFps: number;
  modelPath?: string | undefined;
  mediaMtxRtspBaseUrl?: string | undefined;
  mediaMtxRtmpBaseUrl?: string | undefined;
  mediaMtxApiUrl?: string | undefined;
  fffleetUrl?: string | undefined;
  udpGatewayHost?: string | undefined;
  udpGatewayPort?: number | undefined;
  udpGatewayEnabled?: boolean | undefined;
  streams: CameraStreamConfig[];
  modelInputSize?: number | undefined;
  modelChannelOrder?: 'bgr' | 'rgb' | undefined;
  ortProviders?: string[] | undefined;
  picamUrl?: string | undefined;
  pauseWhileMoving?: boolean | undefined;
  fffleetToken?: string | undefined;
  fffleetClientId?: string | undefined;
  fffleetClientSecret?: string | undefined;
  mjpegWorkers?: string[] | undefined;
  feedWorkerPreference?: string[] | undefined;
  feedRequires?: string[] | undefined;
  autostartFeeds?: boolean | undefined;
  remoteDetect?: 'auto' | 'off' | undefined;
  remoteModel?: string | undefined;
  remoteWorkers?: string[] | undefined;
  remoteRequires?: string[] | undefined;
  remoteCheckMs?: number | undefined;
  localFps?: number | undefined;
  ortThreads?: number | undefined;
}
