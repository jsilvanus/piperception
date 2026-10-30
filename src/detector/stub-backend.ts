import type { DetectorBackend } from './types.js';
import type { RawDetection } from '../types.js';

export class StubDetector implements DetectorBackend {
  readonly name = 'stub';
  private cannedDetections: RawDetection[];

  constructor(initialDetections: RawDetection[] = []) {
    this.cannedDetections = initialDetections;
  }

  setDetections(dets: RawDetection[]): void {
    this.cannedDetections = dets;
  }

  async detect(_frame?: Buffer | unknown): Promise<RawDetection[]> {
    return [...this.cannedDetections];
  }
}
