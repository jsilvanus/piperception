import { loadConfig } from './config.js';
import { PiSpacePusher } from './sink/pispace-pusher.js';
import { UdpTrackingPublisher } from './sink/udp-tracking-publisher.js';
import { StreamManager } from './stream/stream-manager.js';
import { FeedManager } from './ingest/feed-manager.js';
import { createServer } from './server.js';

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
  console.log(`Streams Config:  ${config.streams.map((s) => s.cameraId).join(', ')}`);
  console.log('='.repeat(60));

  const pusher = new PiSpacePusher(config.pispaceUrl, config.pigatewayUrl);
  const udpPublisher = new UdpTrackingPublisher({
    host: config.udpGatewayHost ?? '127.0.0.1',
    port: config.udpGatewayPort ?? 40002,
    enabled: config.udpGatewayEnabled !== false,
  });

  const streamManager = new StreamManager(pusher, config.autoPushPiSpace, udpPublisher);

  // Feed manager for MediaMTX / ff-fleet ingestion
  const feedManager = new FeedManager(streamManager, {
    mediaMtxRtspBaseUrl: config.mediaMtxRtspBaseUrl ?? 'rtsp://127.0.0.1:8554',
    mediaMtxRtmpBaseUrl: config.mediaMtxRtmpBaseUrl ?? 'rtmp://127.0.0.1:1935',
    fffleetUrl: config.fffleetUrl ?? 'http://127.0.0.1:5000',
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
      enabled: streamConfig.enabled !== false,
    });
  }

  const app = createServer(streamManager, pusher, config, feedManager, udpPublisher);

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
    streamManager.stopAll();
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
