import { loadConfig } from './config.js';
import { PiSpacePusher } from './sink/pispace-pusher.js';
import { StreamManager } from './stream/stream-manager.js';
import { createServer } from './server.js';

export async function startPerceptionServer(): Promise<void> {
  const config = loadConfig();

  console.log('='.repeat(60));
  console.log('    PiPerception | 2D Person Detection & Tracking Engine');
  console.log('='.repeat(60));
  console.log(`Port:            ${config.port}`);
  console.log(`PiSpace Target:  ${config.pispaceUrl}`);
  console.log(`Auto-Push:       ${config.autoPushPiSpace}`);
  console.log(`Default FPS:     ${config.defaultFps}`);
  console.log(`Streams Config:  ${config.streams.map((s) => s.cameraId).join(', ')}`);
  console.log('='.repeat(60));

  const pusher = new PiSpacePusher(config.pispaceUrl, config.pigatewayUrl);
  const streamManager = new StreamManager(pusher, config.autoPushPiSpace);

  // Initialize configured streams
  for (const streamConfig of config.streams) {
    streamManager.addStream(streamConfig);
  }

  const app = createServer(streamManager, pusher, config);

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
    console.log('\nShutting down PiPerception streams...');
    streamManager.stopAll();
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
