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
  scale?: string | undefined;
  quality?: number | undefined;
  fleetUrl?: string | undefined;
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
  lastError?: string | undefined;
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
  fffleetUrl?: string | undefined;
  udpGatewayHost?: string | undefined;
  udpGatewayPort?: number | undefined;
  udpGatewayEnabled?: boolean | undefined;
  streams: CameraStreamConfig[];
}
