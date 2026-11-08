import { loadConfig } from './config.js';
import { PiSpacePusher } from './sink/pispace-pusher.js';
import { UdpTrackingPublisher } from './sink/udp-tracking-publisher.js';
import { StreamManager } from './stream/stream-manager.js';
import { FeedManager } from './ingest/feed-manager.js';
import { createServer } from './server.js';
import { FrameHub } from './ingest/frame-hub.js';
import { CameraContextClient } from './context/camera-context-client.js';
import { selectDetector } from './detector/select.js';

export async function startPerceptionServer(): Promise<void> {
  const config = loadConfig();

  console.log('='.repeat(60));
  console.log('    PiPerception | 2D Person Detection & Tracking Engine');
  console.log('='.repeat(60));
  console.log(`Port:            ${config.port}`);
  console.log(`PiSpace Target:  ${config.pispaceUrl}`);
  console.log(`UDP Gateway:     ${config.udpGatewayHost}:${config.udpGatewayPort} (${config.udpGatewayEnabled ? 'enabled' : 'disabled'})`);
  console.log(`MediaMTX Base:   ${config.mediaMtxRtspBaseUrl}`);
  console.log(`ff-fleet:        ${config.fffleetUrl}`);
  console.log(`Auto-Push:       ${config.autoPushPiSpace}`);
  console.log(`Default FPS:     ${config.defaultFps}`);
  console.log(`picam context:   ${config.picamUrl ?? 'off (no gating)'}`);
  console.log(`Model:           ${config.modelPath ?? 'none (stub detector)'}`);
  console.log(`Remote detect:   ${config.remoteDetect}${config.remoteDetect === 'auto' ? ` (model ${config.remoteModel ?? 'yolox_tiny'})` : ''}; local cap ${config.localFps} fps`);
  console.log(`Streams Config:  ${config.streams.map((s) => s.cameraId).join(', ')}`);
  console.log('='.repeat(60));

  const pusher = new PiSpacePusher(config.pispaceUrl, config.pigatewayUrl);
  const udpPublisher = new UdpTrackingPublisher({
    host: config.udpGatewayHost ?? '127.0.0.1',
    port: config.udpGatewayPort ?? 40002,
    enabled: config.udpGatewayEnabled !== false,
  });

  const streamManager = new StreamManager(pusher, config.autoPushPiSpace, udpPublisher);
  streamManager.updateSettings({ pauseWhileMoving: config.pauseWhileMoving !== false });

  // Real cameras: YOLOX through onnxruntime when a model is configured, else the stub (reason in /health).
  const { detector, info: detectorInfo } = await selectDetector({
    modelPath: config.modelPath,
    inputSize: config.modelInputSize,
    channelOrder: config.modelChannelOrder,
    executionProviders: config.ortProviders,
    threads: config.ortThreads,
  });
  streamManager.setDefaultDetector(detector);
  console.log(`Detector:        ${detectorInfo.name}${detectorInfo.reason ? ` (${detectorInfo.reason})` : ''}`);

  // Camera context from picam: stale, privacy blur, moving or frozen means "unknown".
  let contextClient: CameraContextClient | undefined;
  if (config.picamUrl) {
    contextClient = new CameraContextClient({
      baseUrl: config.picamUrl,
      cameraIds: config.streams.filter((s) => s.sourceType !== 'simulation').map((s) => s.cameraId),
    });
    streamManager.setContextSource((id) => contextClient!.getView(id));
    contextClient.start();
  }

  // Frames: fffleet stream job per camera -> FrameHub -> detectors (each at its own pace).
  const hub = new FrameHub((consumer, cameraId, err: any) => {
    console.error(`[${consumer}] ${cameraId}: ${err?.message ?? err}`);
  });
  hub.addConsumer(streamManager.asFrameConsumer());

  const feedManager = new FeedManager(streamManager, {
    mediaMtxRtspBaseUrl: config.mediaMtxRtspBaseUrl ?? 'rtsp://127.0.0.1:8554',
    mediaMtxRtmpBaseUrl: config.mediaMtxRtmpBaseUrl ?? 'rtmp://127.0.0.1:1935',
    fffleetUrl: config.fffleetUrl ?? 'http://127.0.0.1:5000',
    fffleetToken: config.fffleetToken,
    fffleetClientId: config.fffleetClientId,
    fffleetClientSecret: config.fffleetClientSecret,
    mjpegWorkers: config.mjpegWorkers,
    workerPreference: config.feedWorkerPreference,
    requires: config.feedRequires,
    hub,
    localFps: config.localFps,
    remote: {
      mode: config.remoteDetect,
      model: config.remoteModel,
      inputSize: config.modelInputSize,
      channelOrder: config.modelChannelOrder,
      workerPreference: config.remoteWorkers,
      requires: config.remoteRequires,
      checkIntervalMs: config.remoteCheckMs,
    },
  });
  feedManager.on('feed:remote', (e: any) => {
    console.log(`[remote-detect] ${e.cameraId}: ${e.state}${e.error ? ` (${e.error}; retry in ${Math.round(e.retryInMs / 1000)} s)` : ''}`);
  });

  // Initialize configured streams
  for (const streamConfig of config.streams) {
    streamManager.addStream(streamConfig);

    // Also register default feeds
    feedManager.setupFeed({
      cameraId: streamConfig.cameraId,
      name: streamConfig.name,
      sourceType: streamConfig.sourceType === 'simulation' ? 'simulation' : 'mediamtx',
      fps: streamConfig.fps ?? config.defaultFps,
      enabled: streamConfig.sourceType === 'simulation' ? streamConfig.enabled !== false : true,
    });
  }
  if (config.autostartFeeds) {
    void feedManager.startAll();
  }

  const app = createServer(streamManager, pusher, config, feedManager, udpPublisher, {
    detectorInfo,
    contextClient,
    hub,
  });

  try {
    const address = await app.listen({ port: config.port, host: config.host });
    console.log(`\n🚀 PiPerception server listening at: ${address}`);
    console.log(`📊 Web UI Console available at:       http://localhost:${config.port}`);
  } catch (err: any) {
    console.error(`Failed to start PiPerception server: ${err.message}`);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down PiPerception streams and feeds...');
    await feedManager.stopAll();
    contextClient?.stop();
    streamManager.stopAll();
    await detector.close?.();
    udpPublisher.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// If executed directly
if (import.meta.url.endsWith(process.argv[1] ?? '')) {
  startPerceptionServer();
}
