import { EventEmitter } from 'events';
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import type {
  RegisterRequest,
  IngestEventsRequest,
  HeartbeatRequest,
  RuntimeMetrics,
  TelemetryEvent,
  ToolRegistration,
} from './types';
import { EventBuffer } from './buffer';

export interface TransportConfig {
  endpoint: string;
  apiKey: string;
  serviceName: string;
  instanceId: string;
  flushIntervalMs: number;
  heartbeatIntervalMs: number;
  bufferCapacity: number;
  debug: boolean;
  /** Transport mode (default: 'sse') */
  transport?: 'sse' | 'ws';
}

/** Inbound message from Sandworm platform (via SSE or WS) */
export type InboundMessage =
  | { type: 'tool_call'; id: string; tool: string; args: unknown }
  | { type: 'ping' }
  | { type: 'registered'; serviceId: string }
  | { type: 'error'; message: string };

/** Outbound message to Sandworm platform (via HTTP POST or WS) */
export type OutboundMessage =
  | { type: 'register'; payload: RegisterRequest }
  | { type: 'heartbeat'; payload: HeartbeatRequest }
  | { type: 'events'; payload: IngestEventsRequest }
  | { type: 'tool_result'; id: string; result: unknown; error?: string; durationMs: number }
  | { type: 'pong' };

/**
 * SSE + POST transport (default).
 *
 * Inbound:  GET /v1/stream → SSE (tool_call, ping, registered, error)
 * Outbound: POST /v1/ingest/* → HTTP (register, events, heartbeat, tool_result)
 *
 * Falls back to WS if configured via `transport: 'ws'`.
 */
export class Transport extends EventEmitter {
  private readonly config: TransportConfig;
  private readonly buffer: EventBuffer;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectDelay = 30_000;
  private tools: ToolRegistration[] = [];

  // Runtime metrics state
  private prevCpuUsage: NodeJS.CpuUsage = { user: 0, system: 0 };
  private prevCpuTime = Date.now();
  private eventLoopHistogram: IntervalHistogram | null = null;

  // SSE state
  private abortController: AbortController | null = null;
  private lastEventId: string | undefined;

  // WS state (fallback)
  private ws: WebSocket | null = null;

  constructor(config: TransportConfig) {
    super();
    this.config = config;
    this.buffer = new EventBuffer(config.bufferCapacity);
  }

  push(event: TelemetryEvent): void {
    this.buffer.push(event);
    if (this.buffer.size >= this.config.bufferCapacity / 2) {
      this.flush();
    }
  }

  async connect(tools: ToolRegistration[]): Promise<void> {
    this.tools = tools;
    this.running = true;

    // Register via HTTP POST first (works for both transports)
    await this.post('/v1/ingest/register', {
      serviceName: this.config.serviceName,
      instanceId: this.config.instanceId,
      sdkVersion: '0.4.0',
      tools: this.tools,
    });

    // Open inbound channel
    if (this.config.transport === 'ws') {
      await this.connectWs();
    } else {
      this.connectSse();
    }

    this.startTimers();
  }

  sendToolResult(id: string, result: unknown, error: string | undefined, durationMs: number): void {
    if (this.config.transport === 'ws') {
      this.wsSend({ type: 'tool_result', id, result, error, durationMs });
    } else {
      this.post('/v1/ingest/tool-result', { id, result, error, durationMs }).catch((err) => {
        this.log(`tool_result POST failed: ${err?.message}`);
      });
    }
  }

  flush(): void {
    if (this.buffer.empty) return;
    const events = this.buffer.drain();

    if (this.config.transport === 'ws' && this.ws?.readyState === WebSocket.OPEN) {
      this.wsSend({ type: 'events', payload: { events } });
    } else {
      this.post('/v1/ingest/events', { events }).catch((err) => {
        this.log(`flush POST failed: ${err?.message}`);
        // Re-buffer events on failure (best effort — may exceed capacity)
        for (const e of events) this.buffer.push(e);
      });
    }
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.stopTimers();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

    // Flush remaining events via HTTP (reliable even if stream is closing)
    if (!this.buffer.empty) {
      const events = this.buffer.drain();
      await this.post('/v1/ingest/events', { events }).catch(() => {});
    }

    // Close inbound channel
    if (this.abortController) { this.abortController.abort(); this.abortController = null; }
    if (this.ws) { this.ws.close(1000, 'shutdown'); this.ws = null; }
  }

  // ── SSE Transport ─────────────────────────────────────────────────

  private connectSse(): void {
    this.abortController = new AbortController();
    const url = `${this.config.endpoint}/v1/stream`;

    this.log(`SSE connecting to ${url}`);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: 'text/event-stream',
      'X-Instance-Id': this.config.instanceId,
    };
    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    fetch(url, {
      headers,
      signal: this.abortController.signal,
    }).then(async (res) => {
      if (!res.ok) {
        this.log(`SSE connection failed: ${res.status}`);
        this.scheduleReconnect();
        return;
      }

      this.log('SSE connected');
      this.reconnectAttempts = 0;
      this.emit('connected');

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let partial = '';

      try {
        while (this.running) {
          const { done, value } = await reader.read();
          if (done) break;

          partial += decoder.decode(value, { stream: true });
          const lines = partial.split('\n');
          partial = lines.pop() ?? '';

          let currentId: string | undefined;
          let currentData = '';

          for (const line of lines) {
            if (line.startsWith('id:')) {
              currentId = line.slice(3).trim();
            } else if (line.startsWith('data:')) {
              currentData += line.slice(5).trim();
            } else if (line === '') {
              // End of event
              if (currentData) {
                if (currentId) this.lastEventId = currentId;
                this.handleSseData(currentData);
              }
              currentId = undefined;
              currentData = '';
            }
          }
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          this.log(`SSE read error: ${err?.message}`);
        }
      } finally {
        reader.releaseLock();
      }

      // Stream ended — reconnect if still running
      if (this.running) {
        this.log('SSE stream ended');
        this.scheduleReconnect();
      }
    }).catch((err: any) => {
      if (err?.name !== 'AbortError') {
        this.log(`SSE fetch error: ${err?.message}`);
        if (this.running) this.scheduleReconnect();
      }
    });
  }

  private handleSseData(data: string): void {
    try {
      const msg: InboundMessage = JSON.parse(data);
      this.handleInbound(msg);
    } catch {
      this.log(`invalid SSE data: ${data}`);
    }
  }

  // ── WebSocket Transport (fallback) ────────────────────────────────

  private connectWs(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = this.config.endpoint
        .replace(/^http/, 'ws')
        .replace(/\/$/, '') + '/v1/ws';

      this.log(`WS connecting to ${wsUrl}`);

      this.ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      } as any);

      let resolved = false;

      this.ws.addEventListener('open', () => {
        this.log('WS connected');
        this.reconnectAttempts = 0;
        this.wsSend({
          type: 'register',
          payload: {
            serviceName: this.config.serviceName,
            instanceId: this.config.instanceId,
            sdkVersion: '0.4.0',
            tools: this.tools,
          },
        });
        if (!resolved) { resolved = true; resolve(); }
      });

      this.ws.addEventListener('message', (event: any) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        try {
          const msg: InboundMessage = JSON.parse(data);
          this.handleInbound(msg);
        } catch {
          this.log(`invalid WS message: ${data}`);
        }
      });

      this.ws.addEventListener('close', () => {
        this.log('WS disconnected');
        if (this.running) this.scheduleReconnect();
      });

      this.ws.addEventListener('error', (err: any) => {
        this.log(`WS error: ${err?.message ?? err}`);
        if (!resolved) { resolved = true; reject(new Error('Failed to connect to Sandworm')); }
      });
    });
  }

  // ── Shared ────────────────────────────────────────────────────────

  private handleInbound(msg: InboundMessage): void {
    switch (msg.type) {
      case 'tool_call':
        this.emit('tool_call', msg);
        break;
      case 'ping':
        if (this.config.transport === 'ws') {
          this.wsSend({ type: 'pong' });
        }
        // SSE pings are keepalive — no response needed
        break;
      case 'registered':
        this.log(`registered serviceId=${msg.serviceId}`);
        this.emit('registered', msg.serviceId);
        break;
      case 'error':
        this.log(`platform error: ${msg.message}`);
        this.emit('platform_error', msg.message);
        break;
    }
  }

  private wsSend(msg: OutboundMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startTimers(): void {
    this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs);
    this.flushTimer.unref();

    // Initialize event loop monitoring
    try {
      this.eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
      this.eventLoopHistogram.enable();
    } catch {
      // Not available in all environments
    }
    this.prevCpuUsage = process.cpuUsage();
    this.prevCpuTime = Date.now();

    this.heartbeatTimer = setInterval(() => {
      const metrics = this.collectMetrics();
      this.post('/v1/ingest/heartbeat', {
        serviceName: this.config.serviceName,
        instanceId: this.config.instanceId,
        metrics,
      }).catch((err) => {
        this.log(`heartbeat failed: ${err?.message}`);
      });
    }, this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private collectMetrics(): RuntimeMetrics {
    const mem = process.memoryUsage();
    const now = Date.now();
    const cpuUsage = process.cpuUsage(this.prevCpuUsage);
    const elapsed = (now - this.prevCpuTime) * 1000; // microseconds
    const cpuPercent = elapsed > 0
      ? Math.round(((cpuUsage.user + cpuUsage.system) / elapsed) * 10000) / 100
      : 0;
    this.prevCpuUsage = process.cpuUsage();
    this.prevCpuTime = now;

    let eventLoopLagMs = 0;
    if (this.eventLoopHistogram) {
      eventLoopLagMs = Math.round((this.eventLoopHistogram.mean / 1e6) * 100) / 100;
      this.eventLoopHistogram.reset();
    }

    return {
      memoryRss: mem.rss,
      memoryHeapUsed: mem.heapUsed,
      memoryHeapTotal: mem.heapTotal,
      memoryExternal: mem.external,
      cpuPercent,
      uptimeSeconds: Math.round(process.uptime()),
      eventLoopLagMs,
    };
  }

  private stopTimers(): void {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.eventLoopHistogram) { this.eventLoopHistogram.disable(); this.eventLoopHistogram = null; }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, this.maxReconnectDelay);
    this.log(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.emit('disconnected', { attempt: this.reconnectAttempts, nextRetryMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.emit('reconnecting', { attempt: this.reconnectAttempts });
      if (this.config.transport === 'ws') {
        this.connectWs().catch((err) => {
          this.log(`WS reconnect failed: ${err.message}`);
        });
      } else {
        this.connectSse();
      }
    }, delay);
    this.reconnectTimer.unref();
  }

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(`${this.config.endpoint}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          'X-Instance-Id': this.config.instanceId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const hint = res.status === 401
          ? ' — check your API key is valid and not revoked'
          : res.status === 404
          ? ' — check your endpoint URL is correct'
          : '';
        throw new Error(`Sandworm API ${res.status}: ${path}${hint}`);
      }

      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name !== 'AbortError') {
        this.log(`POST ${path} error: ${err?.message}`);
      }
      throw err;
    }
  }

  private log(msg: string): void {
    if (this.config.debug) console.log(`[sandworm] ${msg}`);
  }
}
