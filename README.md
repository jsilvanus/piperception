# PiPerception (`piperception`)

**PiPerception** is the real-time computer vision, person detection, and multi-object tracking microservice for the **Pi Ecosystem** (`piecosystem`).

It ingests camera feeds, runs neural person detection (YOLOX on ONNX Runtime CPU/GPU) and ByteTrack multi-target association, and outputs normalized 2D bounding boxes (`[ymin, xmin, ymax, xmax]`) directly into **PiSpace** (`pispace`, port `3108`) for 3D spatial raycasting and sanctuary zone verification.

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
           │     POST http://127.0.0.1:3108/perception   │
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
  - Fastify server hosts an operational dashboard on `http://localhost:3110` with live HTML5 canvas tracking, bounding box overlays, and telemetry.

---

## Network & Port Map

| Port | Protocol | Purpose |
| :--- | :--- | :--- |
| **3110** | HTTP | REST API, SSE (`/api/v1/events`), and Web Dashboard |

---

## REST API Reference

### Health & Status
* `GET /health`: Service health, active streams count, and PiSpace connection state.
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
* `POST /api/v1/cameras/:cameraId/frame`: Ingest a single frame manually (supports Base64 encoded JPEG buffer).
* `GET /api/v1/pusher`: Connection status, push count, and error rate to PiSpace.
* `GET /api/v1/events`: Server-Sent Events (SSE) emitting real-time `detection` frames.

---

## Development

```bash
# Install dependencies
npm install

# Run unit tests
npm test

# Build TypeScript to dist/
npm run build

# Start production server
npm start

# Start development mode with hot reload
npm run dev
```

---

## License

Private / Church Production Stack.
