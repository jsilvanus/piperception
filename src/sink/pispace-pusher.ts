import type { TrackedSubject, BoundingBox2D } from '../types.js';

export interface PusherStats {
  connected: boolean;
  pispaceUrl: string;
  pigatewayUrl?: string | undefined;
  pushCount: number;
  errorCount: number;
  lastPushTimeMs: number;
  lastError?: string | undefined;
}

export class PiSpacePusher {
  readonly pispaceUrl: string;
  readonly pigatewayUrl?: string | undefined;
  private connected = false;
  private pushCount = 0;
  private errorCount = 0;
  private lastPushTimeMs = 0;
  private lastError?: string;

  constructor(pispaceUrl: string, pigatewayUrl?: string) {
    this.pispaceUrl = pispaceUrl.replace(/\/+$/, '');
    this.pigatewayUrl = pigatewayUrl?.replace(/\/+$/, '');
  }

  async pushDetections(cameraId: string, subjects: TrackedSubject[]): Promise<boolean> {
    const payload = {
      cameraId,
      objects: subjects.map((s) => ({
        trackId: s.trackId,
        bbox: s.bbox,
        label: s.label,
        confidence: s.confidence,
      })),
    };

    let success = false;

    // 1. Push to PiSpace
    try {
      const url = `${this.pispaceUrl}/api/v1/perception`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(1500),
      });

      if (res.ok) {
        this.connected = true;
        this.pushCount++;
        this.lastPushTimeMs = Date.now();
        this.lastError = undefined;
        success = true;
      } else {
        const text = await res.text();
        this.errorCount++;
        this.lastError = `PiSpace HTTP ${res.status}: ${text}`;
      }
    } catch (err: any) {
      this.connected = false;
      this.errorCount++;
      this.lastError = `PiSpace connection failed: ${err.message}`;
    }

    // 2. Optionally push to PiGateway event bus
    if (this.pigatewayUrl) {
      try {
        const gwUrl = `${this.pigatewayUrl}/api/v1/events`;
        await fetch(gwUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'perception',
            data: payload,
          }),
          signal: AbortSignal.timeout(1500),
        });
      } catch {
        // Gateway push is best-effort
      }
    }

    return success;
  }

  getStats(): PusherStats {
    return {
      connected: this.connected,
      pispaceUrl: this.pispaceUrl,
      pigatewayUrl: this.pigatewayUrl,
      pushCount: this.pushCount,
      errorCount: this.errorCount,
      lastPushTimeMs: this.lastPushTimeMs,
      lastError: this.lastError,
    };
  }
}
