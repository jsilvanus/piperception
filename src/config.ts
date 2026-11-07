import type { AppConfig, CameraStreamConfig } from './types.js';

export function loadConfig(): AppConfig {
  const port = parseInt(process.env.PORT ?? '3202', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  const pispaceUrl = process.env.PISPACE_URL ?? 'http://127.0.0.1:3203';
  const pigatewayUrl = process.env.PIGATEWAY_URL ?? 'http://127.0.0.1:3000';
  const autoPushPiSpace = process.env.AUTO_PUSH !== 'false';
  const defaultFps = parseInt(process.env.DEFAULT_FPS ?? '10', 10);
  const modelPath = process.env.PERCEPTION_MODEL_PATH;
  const mediaMtxRtspBaseUrl = process.env.MEDIAMTX_RTSP_BASE_URL ?? 'rtsp://127.0.0.1:8554';
  const mediaMtxRtmpBaseUrl = process.env.MEDIAMTX_RTMP_BASE_URL ?? 'rtmp://127.0.0.1:1935';
  const fffleetUrl = process.env.FFFLEET_URL ?? 'http://127.0.0.1:5000';
  const udpGatewayHost = process.env.UDP_GATEWAY_HOST ?? '127.0.0.1';
  const udpGatewayPort = parseInt(process.env.UDP_GATEWAY_PORT ?? '40002', 10);
  const udpGatewayEnabled = process.env.UDP_GATEWAY_ENABLED !== 'false';

  // Default camera streams configured for Riihimäen Keskuskirkko
  const defaultStreams: CameraStreamConfig[] = [
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
    streams: defaultStreams,
  };
}
