import fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig, CameraStreamConfig, FeedConfig } from './types.js';
import type { StreamManager } from './stream/stream-manager.js';
import type { PiSpacePusher } from './sink/pispace-pusher.js';
import type { FeedManager } from './ingest/feed-manager.js';
import type { UdpTrackingPublisher } from './sink/udp-tracking-publisher.js';
import { SimulationDetector } from './detector/simulation-backend.js';
import type { DetectorInfo } from './detector/select.js';
import type { CameraContextClient } from './context/camera-context-client.js';
import type { FrameHub } from './ingest/frame-hub.js';
import type { Frame } from './ingest/frame.js';

export interface ServerExtras {
  detectorInfo?: DetectorInfo | undefined;
  contextClient?: CameraContextClient | undefined;
  hub?: FrameHub | undefined;
}

export function createServer(
  streamManager: StreamManager,
  pusher: PiSpacePusher,
  config: AppConfig,
  feedManager?: FeedManager,
  udpPublisher?: UdpTrackingPublisher,
  extras: ServerExtras = {}
): FastifyInstance {
  const app = fastify({ logger: false });

  app.register(cors, { origin: '*' });

  // Health check
  app.get('/health', async () => {
    const streams = streamManager.getAllStreams();
    const degraded = streams.filter((s) => s.status === 'degraded');
    const detectorInfo = extras.detectorInfo ?? { name: 'stub', reason: 'no model configured' };
    return {
      ok: true,
      service: 'piperception',
      version: '0.1.0',
      // degraded: some camera cannot be analysed now, or real cameras run on the stub detector.
      status: degraded.length || detectorInfo.name === 'stub' ? 'degraded' : 'ok',
      detector: detectorInfo,
      settings: streamManager.settings,
      picam: extras.contextClient
        ? {
            connected: extras.contextClient.isConnected,
            lastError: extras.contextClient.lastError ?? null,
            lastReadAt: extras.contextClient.lastReadAt ? new Date(extras.contextClient.lastReadAt).toISOString() : null,
          }
        : null,
      cameras: Object.fromEntries(
        streams.map((s) => [
          s.cameraId,
          { status: s.status, reasons: s.degradedReasons, presetId: s.presetId, detector: s.detector, tracks: s.trackCount },
        ])
      ),
      frames: extras.hub?.stats() ?? null,
      activeStreams: streams.filter((s) => s.running).length,
      activeFeeds: feedManager ? feedManager.getAllFeeds().filter((f) => f.status === 'active').length : 0,
      pispaceConnected: pusher.getStats().connected,
      udpTelemetry: udpPublisher?.getStats() ?? null,
    };
  });

  // Runtime settings (pauseWhileMoving: treat a moving camera as unknown, default true)
  app.get('/api/v1/settings', async () => streamManager.settings);
  app.put<{ Body: { pauseWhileMoving?: unknown } }>('/api/v1/settings', async (req, reply) => {
    const body = req.body ?? {};
    if (body.pauseWhileMoving !== undefined && typeof body.pauseWhileMoving !== 'boolean') {
      return reply.code(400).send({ error: 'pauseWhileMoving must be a boolean' });
    }
    return streamManager.updateSettings(body as { pauseWhileMoving?: boolean });
  });

  // List all streams
  app.get('/api/v1/streams', async () => {
    return streamManager.getAllStreams();
  });

  // Configure / add stream
  app.post<{
    Body: CameraStreamConfig;
  }>('/api/v1/streams', async (req, reply) => {
    const streamConfig = req.body;
    if (!streamConfig?.cameraId) {
      return reply.code(400).send({ error: 'Missing cameraId' });
    }
    const state = streamManager.addStream(streamConfig);
    return { ok: true, stream: streamConfig.cameraId, running: state.running };
  });

  // Start stream
  app.post<{ Params: { cameraId: string } }>('/api/v1/streams/:cameraId/start', async (req, reply) => {
    const started = streamManager.startStream(req.params.cameraId);
    if (!started) {
      return reply.code(404).send({ error: `Stream ${req.params.cameraId} not found or already running` });
    }
    return { ok: true, cameraId: req.params.cameraId, running: true };
  });

  // Stop stream
  app.post<{ Params: { cameraId: string } }>('/api/v1/streams/:cameraId/stop', async (req, reply) => {
    const stopped = streamManager.stopStream(req.params.cameraId);
    if (!stopped) {
      return reply.code(404).send({ error: `Stream ${req.params.cameraId} not found or already stopped` });
    }
    return { ok: true, cameraId: req.params.cameraId, running: false };
  });

  // Change simulation path
  app.post<{
    Params: { cameraId: string };
    Body: { path: 'altar' | 'pulpit' | 'lectern' | 'choir' | 'wander' };
  }>('/api/v1/streams/:cameraId/path', async (req, reply) => {
    const stream = streamManager.getStream(req.params.cameraId);
    if (!stream) {
      return reply.code(404).send({ error: `Stream ${req.params.cameraId} not found` });
    }
    if (stream.detector instanceof SimulationDetector) {
      stream.detector.setPath(req.body?.path ?? 'altar');
      return { ok: true, cameraId: req.params.cameraId, path: req.body?.path };
    }
    return reply.code(400).send({ error: 'Stream is not running simulation detector' });
  });

  // Active tracked subjects across all cameras
  app.get('/api/v1/tracks', async () => {
    const streams = streamManager.getAllStreams();
    const tracksByCamera: Record<string, any> = {};
    for (const s of streams) {
      tracksByCamera[s.cameraId] = s.activeTracks;
    }
    return tracksByCamera;
  });

  // PiSpace Pusher telemetry
  app.get('/api/v1/pusher', async () => {
    return pusher.getStats();
  });

  // Feeds lifecycle (MediaMTX / RTSP / ff-fleet)
  app.get('/api/v1/feeds', async () => {
    return feedManager ? feedManager.getAllFeeds() : [];
  });

  app.post<{ Body: FeedConfig | FeedConfig[] }>('/api/v1/feeds/setup', async (req, reply) => {
    if (!feedManager) {
      return reply.code(503).send({ error: 'FeedManager not initialized' });
    }
    const body = req.body;
    if (Array.isArray(body)) {
      const results = body.map((f) => feedManager.setupFeed(f));
      return { ok: true, feeds: results };
    }
    if (!body?.cameraId) {
      return reply.code(400).send({ error: 'Missing cameraId in feed configuration' });
    }
    const state = feedManager.setupFeed(body);
    return { ok: true, feed: state };
  });

  app.post<{ Params: { cameraId: string }; Body: Partial<FeedConfig> }>(
    '/api/v1/feeds/:cameraId/setup',
    async (req, reply) => {
      if (!feedManager) {
        return reply.code(503).send({ error: 'FeedManager not initialized' });
      }
      const cameraId = req.params.cameraId;
      const body = req.body ?? {};
      const state = feedManager.setupFeed({
        cameraId,
        sourceType: body.sourceType ?? 'mediamtx',
        ...body,
      });
      return { ok: true, feed: state };
    }
  );

  app.post<{ Params: { cameraId: string } }>('/api/v1/feeds/:cameraId/start', async (req, reply) => {
    if (!feedManager) {
      return reply.code(503).send({ error: 'FeedManager not initialized' });
    }
    const started = await feedManager.startFeed(req.params.cameraId);
    if (!started) {
      return reply.code(404).send({ error: `Feed ${req.params.cameraId} failed to start or not found` });
    }
    return { ok: true, cameraId: req.params.cameraId, running: true };
  });

  app.post<{ Params: { cameraId: string } }>('/api/v1/feeds/:cameraId/stop', async (req, reply) => {
    if (!feedManager) {
      return reply.code(503).send({ error: 'FeedManager not initialized' });
    }
    const stopped = await feedManager.stopFeed(req.params.cameraId);
    if (!stopped) {
      return reply.code(404).send({ error: `Feed ${req.params.cameraId} not found` });
    }
    return { ok: true, cameraId: req.params.cameraId, running: false };
  });

  app.post('/api/v1/feeds/start', async (_req, reply) => {
    if (!feedManager) {
      return reply.code(503).send({ error: 'FeedManager not initialized' });
    }
    const results = await feedManager.startAll();
    return { ok: true, results };
  });

  app.post('/api/v1/feeds/stop', async (_req, reply) => {
    if (!feedManager) {
      return reply.code(503).send({ error: 'FeedManager not initialized' });
    }
    await feedManager.stopAll();
    return { ok: true, stopped: true };
  });

  // UDP Telemetry stats
  app.get('/api/v1/telemetry/udp', async () => {
    return udpPublisher?.getStats() ?? { enabled: false };
  });

  // Manual Frame Ingestion
  app.post<{
    Params: { cameraId: string };
    Body: { frameBase64?: string; detections?: any[] };
  }>('/api/v1/cameras/:cameraId/frame', async (req, reply) => {
    const { cameraId } = req.params;
    let frame: Frame | undefined;
    if (req.body?.frameBase64) {
      // A posted frame is a JPEG; the detector reads its size from the file.
      frame = { cameraId, tsMs: Date.now(), format: 'jpeg', width: 0, height: 0, data: Buffer.from(req.body.frameBase64, 'base64') };
    }
    const result = await streamManager.processFrame(cameraId, frame);
    if (!result) {
      return reply.code(404).send({ error: `Camera stream ${cameraId} not found` });
    }
    return result;
  });

  // Real-time SSE event stream
  app.get('/api/v1/events', (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders?.();

    // Send initial snapshot
    const initial = {
      type: 'snapshot',
      streams: streamManager.getAllStreams(),
      pusher: pusher.getStats(),
    };
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);

    const onDetection = (detection: unknown) => {
      reply.raw.write(`event: detection\ndata: ${JSON.stringify(detection)}\n\n`);
    };

    streamManager.on('detection', onDetection);

    req.raw.on('close', () => {
      streamManager.off('detection', onDetection);
    });
  });

  // Interactive Web UI Dashboard
  app.get('/', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return getDashboardHtml(config, pusher);
  });

  return app;
}

function getDashboardHtml(config: AppConfig, pusher: PiSpacePusher): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>PiPerception Console</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --success: #10b981;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 20px; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid var(--border); }
    h1 { font-size: 20px; display: flex; align-items: center; gap: 10px; }
    .badge { font-size: 11px; padding: 4px 8px; border-radius: 4px; font-weight: bold; }
    .badge.ok { background: rgba(16, 185, 129, 0.2); color: var(--success); }
    .badge.err { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 20px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .card-title { font-size: 15px; font-weight: 600; }
    .cam-canvas-wrap { position: relative; width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 6px; overflow: hidden; }
    canvas { width: 100%; height: 100%; display: block; }
    .cam-canvas-wrap iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; }
    .cam-canvas-wrap canvas { position: absolute; inset: 0; pointer-events: none; }
    button.on { background: #0369a1; border-color: var(--accent); }
    .controls { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    button, select { background: #334155; color: #fff; border: 1px solid #475569; padding: 6px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; }
    button:hover { background: #475569; }
    .stats { font-size: 12px; color: var(--muted); margin-top: 8px; display: flex; gap: 15px; }
    .pusher-bar { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
  </style>
</head>
<body>
  <header>
    <h1>👁️ PiPerception <span style="font-size: 13px; color: var(--muted); font-weight: normal;">| 2D Person Detection & Tracking Engine</span></h1>
    <span id="serviceBadge" class="badge ok">Live Tracking Active</span>
  </header>

  <div class="pusher-bar">
    <div>
      <strong>PiSpace Destination:</strong> <code style="color: var(--accent);">${config.pispaceUrl}</code>
      <span id="pusherStatus" style="margin-left: 10px;" class="badge ok">Ready</span>
    </div>
    <div id="pusherStats" style="color: var(--muted); font-size: 12px;">
      Pushes sent: 0
    </div>
  </div>

  <div class="grid" id="streamGrid"></div>

  <script>
    const streamGrid = document.getElementById("streamGrid");
    const pusherStatus = document.getElementById("pusherStatus");
    const pusherStats = document.getElementById("pusherStats");

    const streamsData = {};

    function renderStreamCard(s) {
      let div = document.getElementById("card-" + s.cameraId);
      if (!div) {
        div = document.createElement("div");
        div.id = "card-" + s.cameraId;
        div.className = "card";
        div.innerHTML = \`
          <div class="card-header">
            <span class="card-title">📷 \${s.cameraId} (\${s.sourceType})</span>
            <span class="badge \${s.running ? 'ok' : 'err'}" id="status-\${s.cameraId}">\${s.running ? 'ACTIVE' : 'STOPPED'}</span>
          </div>
          <div class="cam-canvas-wrap">
            <canvas id="canvas-\${s.cameraId}" width="960" height="540"></canvas>
          </div>
          <div class="stats" id="stats-\${s.cameraId}">
            <span>FPS: \${s.actualFps}</span>
            <span>Latency: \${s.latencyMs}ms</span>
            <span>Tracks: \${s.trackCount}</span>
          </div>
          <div class="controls">
            <select id="path-\${s.cameraId}">
              <option value="altar">Path: Altar Dais</option>
              <option value="pulpit">Path: Pulpit</option>
              <option value="lectern">Path: Lectern</option>
              <option value="choir">Path: Choir Area</option>
              <option value="wander">Path: Central Aisle</option>
            </select>
            <button onclick="toggleStream('\${s.cameraId}', \${!s.running})">Toggle Run</button>
            <button id="videoBtn-\${s.cameraId}" onclick="toggleVideo('\${s.cameraId}')">Camera feed</button>
          </div>
        \`;
        streamGrid.appendChild(div);

        applyVideo(s.cameraId);
        document.getElementById("path-" + s.cameraId).addEventListener("change", (e) => {
          fetch("/api/v1/streams/" + s.cameraId + "/path", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: e.target.value })
          });
        });
      }

      // Update canvas with bounding boxes
      const canvas = document.getElementById("canvas-" + s.cameraId);
      if (canvas && s.activeTracks) {
        const ctx = canvas.getContext("2d");
        if (videoOn(s.cameraId)) {
          // Camera feed is shown behind the canvas: keep it transparent, draw only the boxes.
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        } else {
          ctx.fillStyle = "#090d16";
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // Grid lines
          ctx.strokeStyle = "#1e293b";
          ctx.lineWidth = 1;
          for (let x = 0; x < canvas.width; x += 40) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
          }
          for (let y = 0; y < canvas.height; y += 40) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
          }
        }

        // Draw bounding boxes
        for (const t of s.activeTracks) {
          const rx = t.rect.x * canvas.width;
          const ry = t.rect.y * canvas.height;
          const rw = t.rect.w * canvas.width;
          const rh = t.rect.h * canvas.height;

          ctx.strokeStyle = "#38bdf8";
          ctx.lineWidth = 2.5;
          ctx.fillStyle = "rgba(56, 189, 248, 0.15)";
          ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeRect(rx, ry, rw, rh);

          // Head circle
          ctx.fillStyle = "#38bdf8";
          ctx.beginPath();
          ctx.arc(rx + rw / 2, ry + Math.min(20, rh * 0.2), 6, 0, Math.PI * 2);
          ctx.fill();

          // Label badge
          ctx.fillStyle = "#38bdf8";
          ctx.fillRect(rx, ry - 20, Math.max(90, rw * 0.8), 20);
          ctx.fillStyle = "#0f172a";
          ctx.font = "bold 11px sans-serif";
          ctx.fillText("ID #" + t.trackId + " (" + Math.round(t.confidence * 100) + "%)", rx + 5, ry - 6);
        }
      }

      const statsEl = document.getElementById("stats-" + s.cameraId);
      if (statsEl) {
        statsEl.innerHTML = \`
          <span>FPS: <strong>\${s.actualFps}</strong></span>
          <span>Latency: <strong>\${s.latencyMs}ms</strong></span>
          <span>Tracks: <strong>\${s.trackCount}</strong></span>
        \`;
      }
    }

    // Camera feed toggle: MediaMTX WebRTC page of the camera path, shown behind the box canvas.
    // Served by MediaMTX on :8889 of the same host the console was opened from. Preference is remembered.
    function videoOn(cameraId) {
      return localStorage.getItem("perception.video." + cameraId) === "1";
    }

    function applyVideo(cameraId) {
      const wrap = document.getElementById("canvas-" + cameraId).parentElement;
      const btn = document.getElementById("videoBtn-" + cameraId);
      let frame = wrap.querySelector("iframe");
      if (videoOn(cameraId)) {
        if (!frame) {
          frame = document.createElement("iframe");
          frame.allow = "autoplay";
          frame.src = location.protocol + "//" + location.hostname + ":8889/" + encodeURIComponent(cameraId) + "?controls=false&muted=true&autoplay=true";
          wrap.insertBefore(frame, wrap.firstChild);
        }
        btn.classList.add("on");
        btn.textContent = "Camera feed: ON";
      } else {
        if (frame) frame.remove();
        btn.classList.remove("on");
        btn.textContent = "Camera feed: OFF";
      }
    }

    function toggleVideo(cameraId) {
      localStorage.setItem("perception.video." + cameraId, videoOn(cameraId) ? "0" : "1");
      applyVideo(cameraId);
    }

    async function toggleStream(cameraId, start) {
      await fetch("/api/v1/streams/" + cameraId + (start ? "/start" : "/stop"), { method: "POST" });
      updateStatus();
    }

    async function updateStatus() {
      try {
        const [streamsRes, pusherRes] = await Promise.all([
          fetch("/api/v1/streams"),
          fetch("/api/v1/pusher")
        ]);
        const streams = await streamsRes.json();
        const pusher = await pusherRes.json();

        for (const s of streams) {
          renderStreamCard(s);
        }

        pusherStatus.className = "badge " + (pusher.connected ? "ok" : "err");
        pusherStatus.textContent = pusher.connected ? "Connected to PiSpace" : "PiSpace Offline";
        pusherStats.textContent = "Pushes sent: " + pusher.pushCount + " | Errors: " + pusher.errorCount;
      } catch (err) {
        console.error("Fetch error:", err);
      }
    }

    // Connect SSE
    const evtSource = new EventSource("/api/v1/events");
    evtSource.addEventListener("detection", (e) => {
      updateStatus();
    });

    setInterval(updateStatus, 1000);
    updateStatus();
  </script>
</body>
</html>`;
}
