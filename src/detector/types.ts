import type { RawDetection } from '../types.js';

export interface DetectorBackend {
  readonly name: string;
  detect(frame?: Buffer | unknown): Promise<RawDetection[]>;
  close?(): Promise<void>;
}
