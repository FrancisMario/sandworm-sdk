import type {
  RegisterRequest,
  IngestEventsRequest,
  HeartbeatRequest,
  TelemetryEvent,
} from './types';
import { EventBuffer } from './buffer';

export interface TransportConfig {
  endpoint: string;
  apiKey: string;
  serviceName: string;
  flushIntervalMs: number;
  heartbeatIntervalMs: number;
  bufferCapacity: number;
  debug: boolean;
}

export class Transport {
  private readonly config: TransportConfig;
  private readonly buffer: EventBuffer;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: TransportConfig) {
    this.config = config;
    this.buffer = new EventBuffer(config.bufferCapacity);
  }

  push(event: TelemetryEvent): void {
    this.buffer.push(event);
    // Auto-flush if buffer hits half capacity
    if (this.buffer.size >= this.config.bufferCapacity / 2) {
      this.flush().catch(this.onError);
    }
  }

  async register(request: RegisterRequest): Promise<{ serviceId: string } | null> {
    return this.post('/v1/ingest/register', request);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.flushTimer = setInterval(() => {
      this.flush().catch(this.onError);
    }, this.config.flushIntervalMs);
    this.flushTimer.unref();

    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch(this.onError);
    }, this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.flushTimer = null;
    this.heartbeatTimer = null;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.empty) return;
    const events = this.buffer.drain();
    const body: IngestEventsRequest = { events };
    await this.post('/v1/ingest/events', body);
  }

  private async heartbeat(): Promise<void> {
    const body: HeartbeatRequest = { serviceName: this.config.serviceName };
    await this.post('/v1/ingest/heartbeat', body);
  }

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(`${this.config.endpoint}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        this.onError(new Error(`Sandworm API ${res.status}: ${path}`));
        return null;
      }

      return (await res.json()) as T;
    } catch (err) {
      this.onError(err);
      return null;
    }
  }

  private onError = (err: unknown): void => {
    if (this.config.debug) {
      console.error('[sandworm]', err);
    }
  };
}
