import { EventEmitter } from 'node:events';
import type { CameraContext, CameraHealthState, CameraView } from './camera-context.js';

export interface CameraContextClientOptions {
  /** picam base URL, e.g. http://127.0.0.1:3102 */
  baseUrl: string;
  cameraIds: string[];
  fetch?: typeof fetch;
  /** Delay before reconnecting the SSE stream (doubles up to maxReconnectMs). */
  reconnectMs?: number;
  maxReconnectMs?: number;
  requestTimeoutMs?: number;
  /**
   * Re-read /context this often while connected. picam publishes a context event only when the context
   * changes, and the change to `stale` (telemetry stopped) is computed on read, so it needs polling.
   */
  pollMs?: number;
  /**
   * Consecutive failed polls (picam not answering /context) after which the link counts as down: the event
   * stream is dropped and reconnected, and every camera reads "picam unreachable" until picam answers again.
   */
  maxPollFailures?: number;
  /** Time allowed for picam to answer the event stream request (headers). */
  connectTimeoutMs?: number;
}

/**
 * Follows picam's camera context and health: reads /context and /health per camera at start and after
 * every reconnect, then listens to picam's SSE stream (`context` and `health` events).
 * Emits 'change' (cameraId, view) whenever a camera's view changes, and 'connection' (connected).
 */
export class CameraContextClient extends EventEmitter {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly cameraIds: Set<string>;
  private readonly views = new Map<string, CameraView>();
  private connected = false;
  private stopped = true;
  private abort: AbortController | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private delayMs: number;
  private pollFailures = 0;
  lastError: string | undefined;
  /** When picam last answered a context read (ms since epoch); 0 = never. */
  lastReadAt = 0;

  constructor(private readonly options: CameraContextClientOptions) {
    super();
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.cameraIds = new Set(options.cameraIds);
    this.delayMs = options.reconnectMs ?? 1000;
    for (const id of this.cameraIds) this.views.set(id, { context: null, health: 'unknown', connected: false });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Current view of a camera; a camera picam was never asked about has none. */
  getView(cameraId: string): CameraView | null {
    return this.views.get(cameraId) ?? null;
  }

  watch(cameraId: string): void {
    if (this.cameraIds.has(cameraId)) return;
    this.cameraIds.add(cameraId);
    this.views.set(cameraId, { context: null, health: 'unknown', connected: this.connected });
    if (this.connected) void this.loadCamera(cameraId, this.abort?.signal);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.abort?.abort();
    this.abort = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.setConnected(false);
  }

  private setConnected(on: boolean): void {
    if (this.connected === on) return;
    this.connected = on;
    for (const [id, view] of this.views) {
      view.connected = on;
      this.emit('change', id, view);
    }
    this.emit('connection', on);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const ac = new AbortController();
    this.abort = ac;
    try {
      const connectTimer = setTimeout(() => ac.abort(new Error('picam events: no answer')), this.options.connectTimeoutMs ?? 5000);
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/api/v1/events`, {
          headers: { accept: 'text/event-stream' },
          signal: ac.signal,
        });
      } finally {
        clearTimeout(connectTimer);
      }
      if (!res.ok || !res.body) throw new Error(`picam events HTTP ${res.status}`);
      // Subscribe first, then read the state, so no change between the two is lost.
      await Promise.all([...this.cameraIds].map((id) => this.loadCamera(id, ac.signal)));
      this.lastError = undefined;
      this.delayMs = this.options.reconnectMs ?? 1000;
      this.pollFailures = 0;
      this.setConnected(true);
      const pollMs = this.options.pollMs ?? 2000;
      if (pollMs > 0) {
        this.pollTimer = setInterval(() => void this.poll(ac), pollMs);
        this.pollTimer.unref?.();
      }
      await this.readEvents(res.body, ac.signal);
      if (!this.stopped) this.lastError = 'picam event stream ended';
    } catch (err: any) {
      if (!this.stopped) this.lastError = err?.message ?? String(err);
    }
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.stopped) return;
    this.setConnected(false);
    const delay = this.delayMs;
    this.delayMs = Math.min(this.delayMs * 2, this.options.maxReconnectMs ?? 15000);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  /**
   * Re-reads every camera's context and health. The event stream alone can go quiet without ending (picam
   * stuck while shutting down, a half-open connection), which left old "moving"/"privacy blur" state in
   * place until this process restarted; polling keeps the view current, and repeated failures reconnect.
   */
  private async poll(ac: AbortController): Promise<void> {
    if (ac.signal.aborted) return;
    const results = await Promise.all([...this.cameraIds].map((id) => this.loadCamera(id, ac.signal)));
    if (ac.signal.aborted) return;
    if (results.some(Boolean)) {
      this.pollFailures = 0;
      return;
    }
    this.pollFailures++;
    if (this.pollFailures >= (this.options.maxPollFailures ?? 3)) {
      this.pollFailures = 0;
      ac.abort(new Error('picam not answering'));
    }
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<any> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs ?? 2000);
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`picam ${path} HTTP ${res.status}`);
    return res.json();
  }

  /** Reads one camera's context and health; true when picam answered the context read. */
  private async loadCamera(cameraId: string, signal?: AbortSignal): Promise<boolean> {
    const enc = encodeURIComponent(cameraId);
    const [ctx, health] = await Promise.allSettled([
      this.getJson(`/api/v1/cameras/${enc}/context`, signal),
      this.getJson(`/api/v1/cameras/${enc}/health`, signal),
    ]);
    const view = this.views.get(cameraId);
    if (!view || signal?.aborted) return false;
    const context = ctx.status === 'fulfilled' && isContext(ctx.value) ? ctx.value : null;
    const healthNow: CameraHealthState = health.status === 'fulfilled' ? healthState(health.value?.state) : 'unknown';
    const changed = JSON.stringify(view.context) !== JSON.stringify(context) || view.health !== healthNow;
    view.context = context;
    view.health = healthNow;
    if (changed) this.emit('change', cameraId, view);
    if (ctx.status === 'fulfilled') this.lastReadAt = Date.now();
    return ctx.status === 'fulfilled';
  }

  private async readEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const decoder = new TextDecoder();
    let buf = '';
    const reader = body.getReader();
    const onAbort = () => void reader.cancel().catch(() => {});
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data) this.handleEvent(data);
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private handleEvent(raw: string): void {
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (event?.type === 'context' && isContext(event.data)) {
      const view = this.views.get(event.data.cameraId);
      if (!view) return;
      view.context = event.data;
      this.emit('change', event.data.cameraId, view);
    } else if (event?.type === 'health' && typeof event.data?.cameraId === 'string') {
      const view = this.views.get(event.data.cameraId);
      if (!view) return;
      view.health = healthState(event.data.state);
      this.emit('change', event.data.cameraId, view);
    }
  }
}

function isContext(v: any): v is CameraContext {
  return !!v && typeof v === 'object' && typeof v.cameraId === 'string' && typeof v.moving === 'boolean';
}

function healthState(s: unknown): CameraHealthState {
  return s === 'ok' || s === 'degraded' || s === 'frozen' ? s : 'unknown';
}
