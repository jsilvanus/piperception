import type { AppConfig, CameraStreamConfig } from './types.js';

export function loadConfig(): AppConfig {
  const port = parseInt(process.env.PORT ?? '3202', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  const pispaceUrl = process.env.PISPACE_URL ?? 'http://127.0.0.1:3203';
  const pigatewayUrl = process.env.PIGATEWAY_URL ?? 'http://127.0.0.1:3000';
  const autoPushPiSpace = process.env.AUTO_PUSH !== 'false';
  const defaultFps = parseInt(process.env.DEFAULT_FPS ?? '5', 10);
  const modelPath = process.env.PERCEPTION_MODEL_PATH || undefined;
  const modelInputSize = parseInt(process.env.PERCEPTION_MODEL_INPUT ?? '416', 10);
  const modelChannelOrder = process.env.PERCEPTION_MODEL_CHANNELS === 'rgb' ? 'rgb' : 'bgr';
  const ortProviders = list(process.env.PERCEPTION_ORT_PROVIDERS) ?? ['cpu'];
  // picam: camera context (moving, preset, privacy blur, stale) and health. 'off' disables gating.
  const picamRaw = process.env.PICAM_URL ?? 'http://127.0.0.1:3102';
  const picamUrl = picamRaw === '' || picamRaw === 'off' ? undefined : picamRaw;
  const pauseWhileMoving = process.env.PAUSE_WHILE_MOVING !== 'false';
  const fffleetToken = process.env.FFFLEET_TOKEN || undefined;
  const fffleetClientId = process.env.FFFLEET_CLIENT_ID || undefined;
  const fffleetClientSecret = process.env.FFFLEET_CLIENT_SECRET || undefined;
  const mjpegWorkers = list(process.env.PERCEPTION_MJPEG_WORKERS) ?? ['operator-pc'];
  const feedWorkerPreference = list(process.env.PERCEPTION_FEED_WORKERS);
  const feedRequires = list(process.env.PERCEPTION_FEED_REQUIRES);
  const source = process.env.PERCEPTION_SOURCE === 'mediamtx' ? 'mediamtx' : 'simulation';
  const autostartFeeds = process.env.PERCEPTION_AUTOSTART_FEEDS === 'true';
  const mediaMtxRtspBaseUrl = process.env.MEDIAMTX_RTSP_BASE_URL ?? 'rtsp://127.0.0.1:8554';
  const mediaMtxRtmpBaseUrl = process.env.MEDIAMTX_RTMP_BASE_URL ?? 'rtmp://127.0.0.1:1935';
  const fffleetUrl = process.env.FFFLEET_URL ?? 'http://127.0.0.1:5000';
  const udpGatewayHost = process.env.UDP_GATEWAY_HOST ?? '127.0.0.1';
  const udpGatewayPort = parseInt(process.env.UDP_GATEWAY_PORT ?? '40002', 10);
  // Remote detection on a fleet worker with the perception-detect executor (the operator PC); local = fallback.
  const remoteDetect = process.env.PERCEPTION_REMOTE_DETECT === 'off' ? 'off' : 'auto';
  const remoteModel = process.env.PERCEPTION_REMOTE_MODEL || undefined;
  const remoteWorkers = list(process.env.PERCEPTION_REMOTE_WORKERS);
  const remoteRequires = list(process.env.PERCEPTION_REMOTE_REQUIRES);
  const remoteCheckMs = int(process.env.PERCEPTION_REMOTE_CHECK_MS);
  // Local detection rate cap and threads: a Pi 4 keeps up with 2 cameras at 1 fps on 2 threads.
  const localFps = num(process.env.PERCEPTION_LOCAL_FPS) ?? 1;
  const ortThreads = int(process.env.PERCEPTION_ORT_THREADS);
  const udpGatewayEnabled = process.env.UDP_GATEWAY_ENABLED !== 'false';

  // Default camera streams. PERCEPTION_SOURCE=mediamtx uses the real analysis streams, else simulation.
  const realStreams: CameraStreamConfig[] = (list(process.env.PERCEPTION_CAMERAS) ?? ['cam1', 'cam2']).map((id) => ({
    cameraId: id,
    name: id,
    sourceType: 'mediamtx',
    fps: defaultFps,
    enabled: false,
    confThreshold: 0.45,
  }));
  const simulationStreams: CameraStreamConfig[] = [
    {
      cameraId: 'cam1',
      name: 'Cam 1 (Chancel Pillar / Altar)',
      sourceType: 'simulation',
      simulationPath: 'altar',
      fps: defaultFps,
      enabled: true,
      confThreshold: 0.45,
    },
    {
      cameraId: 'cam2',
      name: 'Cam 2 (Organ Gallery / Balcony)',
      sourceType: 'simulation',
      simulationPath: 'wander',
      fps: defaultFps,
      enabled: true,
      confThreshold: 0.45,
    },
  ];

  return {
    port,
    host,
    pispaceUrl,
    pigatewayUrl,
    autoPushPiSpace,
    defaultFps,
    modelPath,
    mediaMtxRtspBaseUrl,
    mediaMtxRtmpBaseUrl,
    fffleetUrl,
    udpGatewayHost,
    udpGatewayPort,
    udpGatewayEnabled,
    streams: source === 'mediamtx' ? realStreams : simulationStreams,
    modelInputSize,
    modelChannelOrder,
    ortProviders,
    picamUrl,
    pauseWhileMoving,
    fffleetToken,
    fffleetClientId,
    fffleetClientSecret,
    mjpegWorkers,
    feedWorkerPreference,
    feedRequires,
    autostartFeeds,
    remoteDetect,
    remoteModel,
    remoteWorkers,
    remoteRequires,
    remoteCheckMs,
    localFps,
    ortThreads,
  };
}

function list(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}

function int(v: string | undefined): number | undefined {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function num(v: string | undefined): number | undefined {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
