import dgram from 'node:dgram';
import type { TrackedSubject } from '../types.js';
import {
  encodeTrackingPacket,
  trackedSubjectsToPacket,
  type ScreenTrackingPacket,
} from './udp-tracking-protocol.js';

export interface UdpTrackingPublisherOptions {
  host: string;
  port: number;
  enabled?: boolean;
}

export class UdpTrackingPublisher {
  readonly host: string;
  readonly port: number;
  readonly enabled: boolean;
  private socket: dgram.Socket | null = null;
  private sequences = new Map<string, number>();
  private sentCount = 0;
  private errorCount = 0;

  constructor(options: UdpTrackingPublisherOptions) {
    this.host = options.host;
    this.port = options.port;
    this.enabled = options.enabled !== false;
  }

  private ensureSocket(): dgram.Socket {
    if (!this.socket) {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('error', () => {
        this.errorCount++;
      });
    }
    return this.socket;
  }

  sendTracks(cameraId: string, subjects: TrackedSubject[], timestampMs = Date.now()): boolean {
    if (!this.enabled) return false;

    const seq = (this.sequences.get(cameraId) ?? 0) + 1;
    this.sequences.set(cameraId, seq);

    const packet = trackedSubjectsToPacket(cameraId, seq, subjects, timestampMs);
    const buf = encodeTrackingPacket(packet);

    try {
      const sock = this.ensureSocket();
      sock.send(buf, 0, buf.length, this.port, this.host, (err) => {
        if (err) {
          this.errorCount++;
        } else {
          this.sentCount++;
        }
      });
      return true;
    } catch {
      this.errorCount++;
      return false;
    }
  }

  getStats(): { enabled: boolean; host: string; port: number; sentCount: number; errorCount: number } {
    return {
      enabled: this.enabled,
      host: this.host,
      port: this.port,
      sentCount: this.sentCount,
      errorCount: this.errorCount,
    };
  }

  close(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
  }
}
