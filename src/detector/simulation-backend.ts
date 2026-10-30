import type { DetectorBackend } from './types.js';
import type { RawDetection, RectBox } from '../types.js';

export type SimulationPathType = 'altar' | 'pulpit' | 'lectern' | 'choir' | 'wander';

export class SimulationDetector implements DetectorBackend {
  readonly name = 'simulation';
  private frameCount = 0;
  private pathType: SimulationPathType;
  private confidence: number;

  constructor(pathType: SimulationPathType = 'altar', confidence = 0.92) {
    this.pathType = pathType;
    this.confidence = confidence;
  }

  setPath(pathType: SimulationPathType): void {
    this.pathType = pathType;
  }

  async detect(_frame?: Buffer | unknown): Promise<RawDetection[]> {
    this.frameCount++;
    const t = this.frameCount * 0.05; // ~20 frames per second cycle

    let rect: RectBox;

    switch (this.pathType) {
      case 'pulpit': {
        // Pulpit view (camera left, elevated)
        const x = 0.22 + Math.sin(t * 0.4) * 0.04;
        const y = 0.28 + Math.cos(t * 0.3) * 0.02;
        const w = 0.14;
        const h = 0.38;
        rect = { x, y, w, h };
        break;
      }
      case 'lectern': {
        // Lectern view (camera right)
        const x = 0.68 + Math.sin(t * 0.5) * 0.03;
        const y = 0.32 + Math.cos(t * 0.4) * 0.02;
        const w = 0.13;
        const h = 0.36;
        rect = { x, y, w, h };
        break;
      }
      case 'choir': {
        // Choir area (further to the right)
        const x = 0.78 + Math.sin(t * 0.2) * 0.05;
        const y = 0.35 + Math.cos(t * 0.2) * 0.03;
        const w = 0.12;
        const h = 0.32;
        rect = { x, y, w, h };
        break;
      }
      case 'wander': {
        // Walking down the central nave aisle
        // y varies from 0.2 (far at altar, small box) to 0.7 (close to camera, large box)
        const phase = (Math.sin(t * 0.2) + 1) / 2; // 0..1
        const x = 0.48 + Math.sin(t * 0.8) * 0.04;
        const y = 0.25 + phase * 0.45;
        const w = 0.10 + phase * 0.12;
        const h = 0.28 + phase * 0.32;
        rect = { x, y, w, h };
        break;
      }
      case 'altar':
      default: {
        // Altar chancel dais (center stage)
        const x = 0.46 + Math.sin(t * 0.3) * 0.08;
        const y = 0.30 + Math.cos(t * 0.2) * 0.05;
        const w = 0.15;
        const h = 0.42;
        rect = { x, y, w, h };
        break;
      }
    }

    // Add slight natural noise
    const noise = (Math.random() - 0.5) * 0.005;
    rect.x += noise;
    rect.y += noise;

    return [
      {
        rect,
        score: Math.max(0.75, Math.min(0.99, this.confidence + (Math.random() - 0.5) * 0.05)),
        classIndex: 0,
        label: 'person',
      },
    ];
  }
}
