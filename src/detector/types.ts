import type { RawDetection } from '../types.js';

export interface DetectorBackend {
  readonly name: string;
  /** frame: a feed Frame (see ingest/frame.ts); simulation and stub detectors ignore it. */
  detect(frame?: unknown): Promise<RawDetection[]>;
  close?(): Promise<void>;
}
