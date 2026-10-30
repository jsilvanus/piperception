import type { BoundingBox2D, RectBox, RawDetection, TrackedSubject } from '../types.js';

export function rectToBbox2D(r: RectBox): BoundingBox2D {
  const ymin = Math.max(0, Math.min(1, Math.round(r.y * 1e6) / 1e6));
  const xmin = Math.max(0, Math.min(1, Math.round(r.x * 1e6) / 1e6));
  const ymax = Math.max(0, Math.min(1, Math.round((r.y + r.h) * 1e6) / 1e6));
  const xmax = Math.max(0, Math.min(1, Math.round((r.x + r.w) * 1e6) / 1e6));
  return [ymin, xmin, ymax, xmax];
}

export function bbox2DToRect(b: BoundingBox2D): RectBox {
  const [ymin, xmin, ymax, xmax] = b;
  return {
    x: xmin,
    y: ymin,
    w: Math.max(0, xmax - xmin),
    h: Math.max(0, ymax - ymin),
  };
}

/** Intersection over union of two { x, y, w, h } boxes. */
export function calculateIoU(a: RectBox, b: RectBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Hungarian assignment algorithm for minimum cost bipartite matching.
 * Cost matrix rows = track predictions, cols = detections.
 */
export function hungarianAssign(cost: number[][]): Array<[number, number]> {
  const rows = cost.length;
  const cols = rows ? cost[0]!.length : 0;
  if (!rows || !cols) return [];

  const n = Math.max(rows, cols);
  const BIG = 1e6;

  const a: number[][] = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= n; j++) {
      a[i]![j] = i <= rows && j <= cols ? cost[i - 1]![j - 1]! : BIG;
    }
  }

  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;

      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0]![j]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }

      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]!] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }

  const matches: Array<[number, number]> = [];
  for (let j = 1; j <= cols; j++) {
    const i = p[j]!;
    if (i > 0 && i <= rows && a[i]![j]! < BIG) {
      matches.push([i - 1, j - 1]);
    }
  }

  return matches;
}

/** 1D Kalman filter for smooth bounding box component tracking */
class KalmanComponent {
  x: number;
  v = 0;
  p = 1;
  pv = 1;
  readonly q = 1e-4;
  readonly qv = 1e-3;
  readonly r = 1e-2;

  constructor(init: number) {
    this.x = init;
  }

  predict(): number {
    this.x += this.v;
    this.p += this.pv + this.q;
    this.pv += this.qv;
    return this.x;
  }

  update(measurement: number): void {
    const k = this.p / (this.p + this.r);
    const kv = this.pv / (this.p + this.r);
    const err = measurement - this.x;
    this.x += k * err;
    this.v += kv * err;
    this.p *= 1 - k;
    this.pv *= 1 - k;
  }
}

class InternalTrack {
  readonly id: number;
  readonly label: string;
  kx: KalmanComponent;
  ky: KalmanComponent;
  kw: KalmanComponent;
  kh: KalmanComponent;
  score: number;
  hits = 1;
  lost = 0;
  firstSeen: number;
  lastSeen: number;

  constructor(id: number, rect: RectBox, score: number, label: string, now: number) {
    this.id = id;
    this.label = label;
    this.kx = new KalmanComponent(rect.x);
    this.ky = new KalmanComponent(rect.y);
    this.kw = new KalmanComponent(rect.w);
    this.kh = new KalmanComponent(rect.h);
    this.score = score;
    this.firstSeen = now;
    this.lastSeen = now;
  }

  predict(): RectBox {
    return {
      x: this.kx.predict(),
      y: this.ky.predict(),
      w: Math.max(0.01, this.kw.predict()),
      h: Math.max(0.01, this.kh.predict()),
    };
  }

  update(rect: RectBox, score: number, now: number): void {
    this.kx.update(rect.x);
    this.ky.update(rect.y);
    this.kw.update(rect.w);
    this.kh.update(rect.h);
    this.score = score;
    this.hits++;
    this.lost = 0;
    this.lastSeen = now;
  }

  getRect(): RectBox {
    return {
      x: Math.max(0, Math.min(1, this.kx.x)),
      y: Math.max(0, Math.min(1, this.ky.x)),
      w: Math.max(0.01, Math.min(1, this.kw.x)),
      h: Math.max(0.01, Math.min(1, this.kh.x)),
    };
  }

  toSubject(): TrackedSubject {
    const rect = this.getRect();
    return {
      trackId: this.id,
      rect,
      bbox: rectToBbox2D(rect),
      confidence: Math.round(this.score * 1000) / 1000,
      label: this.label,
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      hits: this.hits,
      velocity: {
        vx: Math.round(this.kx.v * 1000) / 1000,
        vy: Math.round(this.ky.v * 1000) / 1000,
      },
    };
  }
}

export interface ByteTrackerOptions {
  /** Minimum score to consider high-confidence detection (default 0.45) */
  highScoreThresh?: number;
  /** Minimum score to consider low-confidence candidate in stage 2 (default 0.15) */
  lowScoreThresh?: number;
  /** Minimum IoU to associate detection with track (default 0.25) */
  matchIoUThresh?: number;
  /** Maximum consecutive lost frames before track deletion (default 15) */
  maxLost?: number;
  /** Minimum hits required before reporting track (default 2) */
  minHits?: number;
}

export class ByteTracker {
  private nextTrackId = 1;
  private tracks: InternalTrack[] = [];
  readonly highScoreThresh: number;
  readonly lowScoreThresh: number;
  readonly matchIoUThresh: number;
  readonly maxLost: number;
  readonly minHits: number;

  constructor(options: ByteTrackerOptions = {}) {
    this.highScoreThresh = options.highScoreThresh ?? 0.45;
    this.lowScoreThresh = options.lowScoreThresh ?? 0.15;
    this.matchIoUThresh = options.matchIoUThresh ?? 0.25;
    this.maxLost = options.maxLost ?? 15;
    this.minHits = options.minHits ?? 2;
  }

  /**
   * Process a single video frame's raw detections and return active confirmed tracks.
   */
  update(detections: RawDetection[], now = Date.now()): TrackedSubject[] {
    // 1. Separate detections into high-score and low-score
    const highDets: RawDetection[] = [];
    const lowDets: RawDetection[] = [];

    for (const d of detections) {
      if (d.score >= this.highScoreThresh) {
        highDets.push(d);
      } else if (d.score >= this.lowScoreThresh) {
        lowDets.push(d);
      }
    }

    // 2. Predict all existing tracks
    const trackBoxes = this.tracks.map((t) => t.predict());

    // 3. First association: Match high-confidence detections with existing tracks
    const costHigh: number[][] = trackBoxes.map((tb) =>
      highDets.map((d) => 1.0 - calculateIoU(tb, d.rect))
    );

    const matchesHigh = hungarianAssign(costHigh);
    const matchedTrackIndices = new Set<number>();
    const matchedHighDetIndices = new Set<number>();

    for (const [tIdx, dIdx] of matchesHigh) {
      if (costHigh[tIdx]![dIdx]! <= 1.0 - this.matchIoUThresh) {
        this.tracks[tIdx]!.update(highDets[dIdx]!.rect, highDets[dIdx]!.score, now);
        matchedTrackIndices.add(tIdx);
        matchedHighDetIndices.add(dIdx);
      }
    }

    // 4. Second association: Match remaining unmatched tracks with low-confidence detections
    const unmatchedTracks: number[] = [];
    for (let i = 0; i < this.tracks.length; i++) {
      if (!matchedTrackIndices.has(i)) unmatchedTracks.push(i);
    }

    if (unmatchedTracks.length > 0 && lowDets.length > 0) {
      const costLow: number[][] = unmatchedTracks.map((tIdx) =>
        lowDets.map((d) => 1.0 - calculateIoU(trackBoxes[tIdx]!, d.rect))
      );

      const matchesLow = hungarianAssign(costLow);
      for (const [row, col] of matchesLow) {
        const tIdx = unmatchedTracks[row]!;
        if (costLow[row]![col]! <= 1.0 - this.matchIoUThresh) {
          this.tracks[tIdx]!.update(lowDets[col]!.rect, lowDets[col]!.score, now);
          matchedTrackIndices.add(tIdx);
        }
      }
    }

    // 5. Increment lost count for tracks that were not matched in either stage
    for (let i = 0; i < this.tracks.length; i++) {
      if (!matchedTrackIndices.has(i)) {
        this.tracks[i]!.lost++;
      }
    }

    // 6. Create new tracks from unmatched high-confidence detections
    for (let i = 0; i < highDets.length; i++) {
      if (!matchedHighDetIndices.has(i)) {
        const det = highDets[i]!;
        const track = new InternalTrack(this.nextTrackId++, det.rect, det.score, det.label, now);
        this.tracks.push(track);
      }
    }

    // 7. Remove dead tracks (lost > maxLost)
    this.tracks = this.tracks.filter((t) => t.lost <= this.maxLost);

    // 8. Return confirmed tracks that have met minHits
    const activeConfirmed: TrackedSubject[] = [];
    for (const t of this.tracks) {
      if (t.hits >= this.minHits && t.lost === 0) {
        activeConfirmed.push(t.toSubject());
      }
    }

    return activeConfirmed;
  }

  /** Reset all tracks (e.g. camera scene switch) */
  reset(): void {
    this.tracks = [];
    this.nextTrackId = 1;
  }

  get activeTrackCount(): number {
    return this.tracks.filter((t) => t.hits >= this.minHits && t.lost === 0).length;
  }
}
