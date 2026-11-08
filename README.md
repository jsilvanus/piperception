# PiPerception (`piperception`)

**PiPerception** is the real-time computer vision, person detection, and multi-object tracking microservice for the **Pi Ecosystem** (`piecosystem`).

It ingests camera feeds, runs neural person detection (YOLOX on ONNX Runtime CPU/GPU) and ByteTrack multi-target association, and outputs normalized 2D bounding boxes (`[ymin, xmin, ymax, xmax]`) directly into **PiSpace** (`pispace`, port `3203`) for 3D spatial raycasting and sanctuary zone verification.

```
 [AVer PTZ Cameras]     [Simulation Engine]      [HTTP Frame Ingest]
   (RTSP / Video)        (Altar / Pulpit Path)      (Manual / Test)
           │                      │                       │
           └──────────────────────┼───────────────────────┘
                                  ▼
                    ┌───────────────────────────┐
                    │  YOLOX Neural Detection   │
                    │   (Anchor Decoding & NMS) │
                    └─────────────┬─────────────┘
                                  ▼
                    ┌───────────────────────────┐
                    │    ByteTrack Tracker      │
                    │ (Kalman Filtering + Match)│
                    └─────────────┬─────────────┘
                                  │ Persistent trackId & [ymin, xmin, ymax, xmax]
                                  ▼
           ┌─────────────────────────────────────────────┐
           │        PiSpace Perception Pusher            │
           │     POST http://127.0.0.1:3203/perception   │
           └──────────────────────┬──────────────────────┘
                                  ▼
             [PiSpace: 3D Floor Raycasting & Zones]
```

---

## Features

- **ByteTrack Multi-Object Tracking**:
  - Two-stage association (matching high-confidence detections, then recovering partially occluded tracks with low-confidence candidates).
  - Kalman filter prediction and velocity smoothing for stable bounding boxes.
  - False-positive rejection via configurable `minHits` (single-frame blips never get tracked).
  - Persistent `trackId` assignment across camera frames.
- **YOLOX Anchor Decoding & NMS**:
  - Pure TypeScript anchor decoder and IoU Non-Maximum Suppression.
  - Model support for YOLOX-nano, YOLOX-tiny, and YOLOX-s.
- **Church Venue Simulation Engine**:
  - Built-in simulation backend generating realistic human movement along sanctuary paths:
    - `altar`: priest/liturgist moving on elevated dais
    - `pulpit`: speaker standing in pulpit
    - `lectern`: reader at scripture desk
    - `choir`: choir member standing in choir area
    - `wander`: procession walking down the central nave aisle
- **PiSpace Integration**:
  - Background worker pushes formatted 2D tracking events directly into `pispace` (`POST /api/v1/perception`).
- **Interactive Web UI Console**:
  - Fastify server hosts an operational dashboard on `http://localhost:3202` with live HTML5 canvas tracking, bounding box overlays, and telemetry.

---

## Real cameras: frames, camera context, detection

Nothing below has run on the Pi or against the real cameras yet.

**Frames.** Each camera is one fffleet stream job reading the MediaMTX analysis stream (`rtsp://…:8554/<cameraId>`), scaled to exactly 640x480 at 5 fps. The base spec sends **rawvideo rgb24** (cut by byte count, no decoding here; meant for a worker on the Pi). A spec variant `mjpeg` sends JPEG to the workers in `PERCEPTION_MJPEG_WORKERS` (default `operator-pc`), so frames from a far worker cost less traffic; they are decoded with jpeg-js. The feed reads `job.variant` before parsing stdout (fffleet >= 2.8). Frames go to a `FrameHub`, which keeps only the newest frame per camera and hands it to each detector at that detector's pace (a busy detector skips frames, nothing queues up).

**Camera context (picam).** `PICAM_URL` (default `http://127.0.0.1:3102`, `off` disables) is followed over SSE plus `/context` and `/health` per camera (context re-read every 2 s, because `stale` is computed on read). A frame is **not analysed** when the context is stale, privacy blur is on, the camera is moving or recalling a preset (only while `pauseWhileMoving` is on, the default), health is `frozen`, there is no context, or picam cannot be reached. Then the camera reports `status: "degraded"` with `reasons` and an empty list, which means **unknown, not "nobody"**: in the PiSpace push (`status`, `reasons`, `presetId`), in the SSE detection events, and as flag bit 0 (`0x0001`) of the UDP tracking packet. The tracker is reset when a camera becomes degraded and when the preset changes, so track IDs do not jump between views. PiSpace now also gets empty sets ("last person left"): once on change and then every 2 s.

**Detector.** With `PERCEPTION_MODEL_PATH` pointing at a YOLOX ONNX model and `onnxruntime-node` installed (optional dependency, CPU binaries for x64 and arm64), real cameras use YOLOX: letterbox to 416 (aspect kept, top-left, pad 114, bilinear), BGR, 0..255 without normalisation, NCHW; boxes are mapped back through the letterbox. Otherwise they use the stub (detects nothing) and `/health` says why. Checked on 2026-11-08 in a 4-core x86 container with the official `yolox_nano.onnx` and `yolox_tiny.onnx` (YOLOX release 0.1.1rc0) on a street photo: the three clearly visible people found by both (nano about 14 ms per frame, tiny about 30 ms). Pi timing not measured yet.

Models (download outside the repo, e.g. into `/home/pi/apps/models/`):
- YOLOX-nano (0.91 M parameters, 1.08 GFLOPs at 416, COCO AP 25.8, 3.7 MB): the default for the Pi.
- YOLOX-tiny (5.06 M parameters, 6.45 GFLOPs at 416, COCO AP 32.8, 20 MB): about 6x the compute of nano, better on small or partly hidden people; for a GPU or a fast CPU.

| Variable | Default | |
|---|---|---|
| `PERCEPTION_SOURCE` | `simulation` | `mediamtx` = real cameras (`PERCEPTION_CAMERAS`, default `cam1,cam2`) |
| `PERCEPTION_AUTOSTART_FEEDS` | `false` | start the camera feeds at startup |
| `DEFAULT_FPS` | `5` | feed rate (the analysis streams run at 5 fps) |
| `PERCEPTION_MODEL_PATH` | unset | YOLOX ONNX file; unset = stub |
| `PERCEPTION_MODEL_INPUT` | `416` | model input size (nano and tiny: 416) |
| `PERCEPTION_MODEL_CHANNELS` | `bgr` | `rgb` for a model trained on RGB |
| `PERCEPTION_ORT_PROVIDERS` | `cpu` | onnxruntime execution providers, e.g. `cuda,cpu` |
| `PICAM_URL` | `http://127.0.0.1:3102` | camera context; `off` = no gating |
| `PAUSE_WHILE_MOVING` | `true` | start value of the runtime option |
| `FFFLEET_URL`, `FFFLEET_TOKEN`, `FFFLEET_CLIENT_ID`, `FFFLEET_CLIENT_SECRET` | `http://127.0.0.1:5000` | fleet orchestrator and login |
| `PERCEPTION_MJPEG_WORKERS` | `operator-pc` | workers that send MJPEG instead of raw frames |
| `PERCEPTION_FEED_WORKERS` | unset | fffleet `workerPreference` for the feed jobs |
| `PERCEPTION_FEED_REQUIRES` | unset | fffleet `requires`, e.g. `net:mediamtx` |

### Remote detection (operator PC), Pi as fallback

On a Pi 4, YOLOX-nano takes about 200-310 ms per 640x480 frame and the Pi throttles within seconds, so two cameras only get about 1 fps each there. A stronger machine runs detection instead, through fffleet:

- **Executor.** `dist/fleet/detect-executor.js` is an fffleet executor for job type **`perception-detect`** (a stream job, `stdout: true`). On the worker, ffmpeg reads the camera stream (`rtsp`, `rtmp`, `srt`, `http(s)` only) at the requested size and rate, YOLOX runs on the newest frame whenever it is free (frames in between are dropped, nothing queues), and the job writes one NDJSON line per analysed frame: `{"v":1,"type":"frame","ts":…,"ms":…,"d":[[x,y,w,h,score],…]}` (normalised, persons only), after a first `hello` line with the model and providers. No frames travel back, only these lines. The worker picks the model file `<model>.onnx` from `PERCEPTION_MODEL_DIR`; the job names only the model (`yolox_tiny` by default), never a path. One onnxruntime session per model is shared by the jobs of a worker and runs one frame at a time.
- **Worker image.** `docker/detect-worker.Dockerfile` = Node 24 + ffmpeg + onnxruntime (CPU) + `fffleet-worker` 2.8.0 + the executor + YOLOX nano and tiny (official release 0.1.1rc0, hash-checked). CI builds and smoke-tests it on every PR and pushes `ghcr.io/jsilvanus/piperception-detect-worker` from main. The operator PC compose in piecosystem runs it. CPU on purpose: the GPU of the operator PC is shared with speech-to-text and Ollama, and tiny on a laptop CPU is about 30-40 ms per frame.
- **Choice and fallback (piperception).** With `PERCEPTION_REMOTE_DETECT=auto` (default) a camera feed first checks the orchestrator's `/v1/capabilities` for `type:perception-detect`. If a worker offers it, the camera gets a `perception-detect` job; once it runs, a local feed of that camera is stopped. If no worker takes it within 10 s, or the job ends (operator PC switched off, network gone), the camera goes back to the local feed at once (frames here, detection here, rate capped by `PERCEPTION_LOCAL_FPS`, default 1). Every `PERCEPTION_REMOTE_CHECK_MS` (30 s) local cameras look for a remote worker again, with back-off after failures (30 s doubling to 5 min). The detections from the remote job go through the same picam gating, ByteTrack, PiSpace push and UDP output as local ones. `/api/v1/feeds` shows per camera `detection` (`local`/`remote`), `remoteWorker`, `remoteModel`, `remoteInferenceMs` and `remoteError`; `/api/v1/streams` shows `detectionSource`.

Checked in a cloud container on 2026-11-08 with a real fffleet 2.8.0 orchestrator and worker (the executor loaded through `FFFLEET_EXECUTORS`) and an HTTP video of a street photo: the job ran on the worker, three people came back at about 35-40 ms per frame (tiny, 2 threads), and when the worker was killed the camera switched to the local feed. Not run on the operator PC or against the real cameras yet.

| Variable | Default | |
|---|---|---|
| `PERCEPTION_REMOTE_DETECT` | `auto` | `off` = never use a remote worker |
| `PERCEPTION_REMOTE_MODEL` | `yolox_tiny` | model name the worker loads (`yolox_nano`, `yolox_tiny`) |
| `PERCEPTION_REMOTE_WORKERS` | unset | fffleet `workerPreference` for detection jobs |
| `PERCEPTION_REMOTE_REQUIRES` | unset | extra fffleet `requires` for detection jobs |
| `PERCEPTION_REMOTE_CHECK_MS` | `30000` | how often local cameras look for a remote worker |
| `PERCEPTION_LOCAL_FPS` | `1` | frame-rate cap of the local feed (detection in this process) |
| `PERCEPTION_ORT_THREADS` | unset | onnxruntime threads (unset = all cores); `2` on a Pi 4 |

On the worker: `PERCEPTION_MODEL_DIR` (default `/models`), `PERCEPTION_ORT_PROVIDERS` (default `cpu`), `PERCEPTION_ORT_THREADS`. The camera URL in the job must be reachable from the worker, so `MEDIAMTX_RTSP_BASE_URL` has to be an address the operator PC can reach (the Pi's LAN address, not `127.0.0.1`).

---

## Network & Port Map

| Port | Protocol | Purpose |
| :--- | :--- | :--- |
| **3202** | HTTP | REST API, SSE (`/api/v1/events`), and Web Dashboard |

---

## REST API Reference

### Health & Status
* `GET /health`: Service health: `status` (`degraded` when a camera cannot be analysed or the stub detector is in use), `detector`, `settings`, `picam` link, per-camera `status`/`reasons`/`presetId`, frame hub counters, PiSpace state.
* `GET /api/v1/settings`, `PUT /api/v1/settings` `{ "pauseWhileMoving": true }`: runtime options.
* `GET /`: Interactive web management console.

### Streams
* `GET /api/v1/streams`: List active camera streams with live FPS, latency, and tracks.
* `POST /api/v1/streams`: Register a new camera stream:
  ```json
  {
    "cameraId": "cam1",
    "name": "Chancel Pillar",
    "sourceType": "simulation",
    "simulationPath": "altar",
    "fps": 10
  }
  ```
* `POST /api/v1/streams/:cameraId/start`: Start tracking loop.
* `POST /api/v1/streams/:cameraId/stop`: Stop tracking loop.
* `POST /api/v1/streams/:cameraId/path`: Change simulated walk path (`altar`, `pulpit`, `lectern`, `choir`, `wander`).

### Detections & Tracking
* `GET /api/v1/tracks`: Get current active tracked subjects across all cameras.
* `POST /api/v1/cameras/:cameraId/frame`: Ingest a single frame manually (`frameBase64`: a JPEG).
* `GET /api/v1/pusher`: Connection status, push count, and error rate to PiSpace.
* `GET /api/v1/events`: Server-Sent Events (SSE) emitting real-time `detection` frames.

---

## Development

```bash
# Install dependencies
pnpm install

# Run unit tests
pnpm test

# Build TypeScript to dist/
pnpm run build

# Start production server
pnpm start

# Start development mode with hot reload
pnpm run dev
```

---

## License

Private / Church Production Stack.

---

## Pi Ecosystem Integration & Status Updates

This project is an integral component of the [Pi Production Ecosystem](file:///d:/piecosystem).

> [!IMPORTANT]
> Any changes to this repository's architectural role, API routes, communication protocols, exposed ports, dependencies, or runtime status **must be documented in the central `piecosystem` coordination repository** (`docs/projects-catalog.md` and `docs/inter-service-matrix.md`).
> Always verify cross-system health with `npm run status` in `D:\piecosystem`.
