import type { FrameFormat } from './frame.js';

export interface FeedSpecOptions {
  streamUrl: string;
  fps: number;
  width: number;
  height: number;
  /** MJPEG quality (-q:v, 2 best .. 31 worst), used by the MJPEG variant only. */
  quality: number;
  /** fffleet worker IDs that should send MJPEG instead of raw frames (they are far from this host). */
  mjpegWorkers: string[];
  /** Optional fffleet workerPreference (ordered allowlist). */
  workerPreference?: string[] | undefined;
  /** Optional fffleet requires (e.g. ['net:mediamtx']). */
  requires?: string[] | undefined;
}

/** Name of the fffleet spec variant that streams MJPEG. The base spec streams rawvideo rgb24. */
export const MJPEG_VARIANT = 'mjpeg';

function inputArgs(streamUrl: string): string[] {
  const args = streamUrl.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : [];
  return [...args, '-i', '{{input:src}}', '-an'];
}

/**
 * The fffleet stream job for one camera feed. Base spec: raw rgb24 frames of exactly width x height
 * (no decoding needed here, cut by byte count; meant for a worker on this host). Variant `mjpeg`: the
 * same frames as JPEG for the workers in `mjpegWorkers` (much less traffic through the orchestrator).
 */
export function buildFeedJobSpec(o: FeedSpecOptions): Record<string, unknown> {
  const vf = `fps=${o.fps},scale=${o.width}:${o.height}`;
  const spec: Record<string, unknown> = {
    kind: 'stream',
    class: 'stream',
    stdout: true,
    labels: { app: 'piperception' },
    inputs: [{ name: 'src', uri: o.streamUrl }],
    ffmpeg: {
      args: [...inputArgs(o.streamUrl), '-vf', vf, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
    },
  };
  if (o.workerPreference?.length) spec.workerPreference = o.workerPreference;
  if (o.requires?.length) spec.requires = o.requires;
  if (o.mjpegWorkers.length) {
    spec.variants = [
      {
        name: MJPEG_VARIANT,
        when: { workers: o.mjpegWorkers },
        ffmpeg: {
          args: [...inputArgs(o.streamUrl), '-vf', vf, '-q:v', String(o.quality), '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
        },
      },
    ];
  }
  return spec;
}

/** The frame format a job's stdout carries, from the variant fffleet chose for it. */
export function formatForVariant(variant: string | null | undefined): FrameFormat {
  return variant === MJPEG_VARIANT ? 'jpeg' : 'rgb24';
}

interface PlacedJob {
  state?: string;
  variant?: string | null;
  snapshot?: { variant?: string | null } | null;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Waits until the job has been placed on a worker, so `job.variant` is known, and returns it.
 * Resolves `undefined` on timeout (the caller then sniffs the bytes).
 */
export function waitForVariant(job: PlacedJob, timeoutMs = 5000): Promise<string | null | undefined> {
  const placed = () => job.state !== undefined && job.state !== 'queued';
  const current = () => job.variant ?? job.snapshot?.variant ?? null;
  if (placed() || !job.on) return Promise.resolve(placed() ? current() : undefined);
  return new Promise((resolve) => {
    const onEvent = (event: { state?: string; variant?: string | null }) => {
      if (event?.state && event.state !== 'queued') {
        cleanup();
        resolve(event.variant !== undefined ? event.variant : current());
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      job.off?.('event', onEvent);
    };
    job.on!('event', onEvent);
  });
}

/** Guess the format from the first bytes when the variant is not known: JPEG starts with FF D8 FF. */
export function sniffFormat(firstChunk: Buffer): FrameFormat {
  return firstChunk.length >= 3 && firstChunk[0] === 0xff && firstChunk[1] === 0xd8 && firstChunk[2] === 0xff ? 'jpeg' : 'rgb24';
}
