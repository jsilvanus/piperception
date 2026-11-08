/** Camera context as picam publishes it (GET /api/v1/cameras/:id/context, SSE {type:"context"}). */
export interface CameraContext {
  cameraId: string;
  presetId: number | null;
  targetPresetId: number | null;
  moving: boolean;
  settled: boolean;
  ptz: { pan: number; tilt: number; zoom: number } | null;
  privacyBlur: boolean;
  focusMode: 'auto' | 'manual';
  updatedAt: string;
  stale: boolean;
}

export type CameraHealthState = 'ok' | 'degraded' | 'frozen' | 'unknown';

export type GateReason = 'no-context' | 'picam-unreachable' | 'stale' | 'privacy-blur' | 'moving' | 'frozen';

export interface GateResult {
  /** ok: frames may be analysed. unknown: nothing can be said about the picture (never "nothing seen"). */
  state: 'ok' | 'unknown';
  reasons: GateReason[];
  presetId: number | null;
}

export interface GateOptions {
  /** Treat a moving camera as unknown (runtime option, default true). */
  pauseWhileMoving: boolean;
}

export interface CameraView {
  context: CameraContext | null;
  health: CameraHealthState;
  /** The SSE link to picam is up. */
  connected: boolean;
}

/** Decides whether a camera's picture can be trusted right now. */
export function assessCamera(view: CameraView | null, options: GateOptions): GateResult {
  const reasons: GateReason[] = [];
  if (!view || !view.connected) reasons.push('picam-unreachable');
  const ctx = view?.context ?? null;
  if (!ctx) reasons.push('no-context');
  else {
    if (ctx.stale) reasons.push('stale');
    if (ctx.privacyBlur) reasons.push('privacy-blur');
    if (options.pauseWhileMoving && (ctx.moving || ctx.targetPresetId !== null)) reasons.push('moving');
  }
  if (view?.health === 'frozen') reasons.push('frozen');
  return { state: reasons.length ? 'unknown' : 'ok', reasons, presetId: ctx?.presetId ?? null };
}
