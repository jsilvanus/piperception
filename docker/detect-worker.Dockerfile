# piperception-detect-worker: an fffleet worker that runs person detection next to the camera stream.
# It claims job type `perception-detect` (src/fleet/detect-executor.ts): ffmpeg reads the camera stream,
# YOLOX runs on onnxruntime (CPU), and only detections go back to piperception.
# Build from the repository root:  docker build -f docker/detect-worker.Dockerfile -t piperception-detect-worker .
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src src
RUN pnpm run build \
 && rm -rf node_modules \
 && pnpm install --frozen-lockfile --prod
# The fffleet worker daemon (same version line as the fffleet client piperception uses).
RUN mkdir /opt/fffleet-worker && cd /opt/fffleet-worker \
 && npm init -y >/dev/null && npm install --omit=dev --ignore-scripts fffleet-worker@2.8.0 && npm cache clean --force

# YOLOX models (Apache-2.0, official release 0.1.1rc0), checked by hash.
FROM node:24-bookworm-slim AS models
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /models
RUN curl -fsSLo yolox_nano.onnx https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx \
 && curl -fsSLo yolox_tiny.onnx https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx \
 && echo "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d  yolox_nano.onnx" | sha256sum -c - \
 && echo "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7  yolox_tiny.onnx" | sha256sum -c -

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /opt/fffleet-worker /opt/fffleet-worker
COPY --from=models /models /models
RUN mkdir -p /var/lib/fffleet && chown node:node /var/lib/fffleet
USER node
ENV NODE_ENV=production \
    PORT=5100 \
    HOST=0.0.0.0 \
    FFFLEET_WORK_DIR=/var/lib/fffleet \
    FFFLEET_EXECUTORS=/app/dist/fleet/detect-executor.js \
    PERCEPTION_MODEL_DIR=/models \
    PERCEPTION_ORT_PROVIDERS=cpu
EXPOSE 5100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/opt/fffleet-worker/node_modules/fffleet-worker/bin/fffleet-worker.js"]
