import type { Frame } from './frame.js';

export interface FrameConsumer {
  readonly name: string;
  /** Minimum time between two frames handed to this consumer for one camera (0 = every frame). */
  readonly minIntervalMs?: number;
  /** Whether this consumer wants frames of that camera now. */
  wants?(cameraId: string): boolean;
  handle(frame: Frame): Promise<void>;
}

interface Lane {
  busy: boolean;
  pending: Frame | null;
  lastHandedMs: number;
  handled: number;
  dropped: number;
}

export interface FrameHubStats {
  cameras: Record<string, { frames: number; lastFrameMs: number }>;
  consumers: Record<string, Record<string, { handled: number; dropped: number }>>;
}

/**
 * Sits between the feeds and the detectors. Keeps only the newest frame per camera and hands it to each
 * consumer at that consumer's own rate: a consumer still busy with a frame gets only the newest one when
 * it is done, the frames in between are dropped. One slow detector never holds up a feed or another detector.
 */
export class FrameHub {
  private consumers: FrameConsumer[] = [];
  private lanes = new Map<string, Lane>();
  private latest = new Map<string, Frame>();
  private frameCounts = new Map<string, number>();

  constructor(private readonly onError: (consumer: string, cameraId: string, err: unknown) => void = () => {}) {}

  addConsumer(consumer: FrameConsumer): void {
    this.consumers.push(consumer);
  }

  /** The newest frame of a camera (for snapshots, calibration). */
  latestFrame(cameraId: string): Frame | undefined {
    return this.latest.get(cameraId);
  }

  publish(frame: Frame): void {
    this.latest.set(frame.cameraId, frame);
    this.frameCounts.set(frame.cameraId, (this.frameCounts.get(frame.cameraId) ?? 0) + 1);
    for (const c of this.consumers) {
      if (c.wants && !c.wants(frame.cameraId)) continue;
      const lane = this.lane(c.name, frame.cameraId);
      if (c.minIntervalMs && frame.tsMs - lane.lastHandedMs < c.minIntervalMs) {
        lane.dropped++;
        continue;
      }
      if (lane.busy) {
        if (lane.pending) lane.dropped++;
        lane.pending = frame;
        continue;
      }
      void this.run(c, lane, frame);
    }
  }

  private lane(consumer: string, cameraId: string): Lane {
    const key = `${consumer}\u0000${cameraId}`;
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { busy: false, pending: null, lastHandedMs: -Infinity, handled: 0, dropped: 0 };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  private async run(c: FrameConsumer, lane: Lane, frame: Frame): Promise<void> {
    lane.busy = true;
    let next: Frame | null = frame;
    while (next) {
      lane.lastHandedMs = next.tsMs;
      lane.handled++;
      try {
        await c.handle(next);
      } catch (err) {
        this.onError(c.name, next.cameraId, err);
      }
      next = lane.pending;
      lane.pending = null;
    }
    lane.busy = false;
  }

  /** Resolves when no consumer is busy (tests). */
  async idle(): Promise<void> {
    while ([...this.lanes.values()].some((l) => l.busy)) {
      await new Promise((r) => setImmediate(r));
    }
  }

  stats(): FrameHubStats {
    const cameras: FrameHubStats['cameras'] = {};
    for (const [id, n] of this.frameCounts) cameras[id] = { frames: n, lastFrameMs: this.latest.get(id)?.tsMs ?? 0 };
    const consumers: FrameHubStats['consumers'] = {};
    for (const [key, lane] of this.lanes) {
      const [name, cam] = key.split('\u0000') as [string, string];
      (consumers[name] ??= {})[cam] = { handled: lane.handled, dropped: lane.dropped };
    }
    return { cameras, consumers };
  }
}
