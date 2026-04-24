import type { TelemetryEvent } from './types';

/**
 * Ring buffer for telemetry events. Drops oldest when full.
 */
export class EventBuffer {
  private buf: (TelemetryEvent | null)[];
  private head = 0;
  private count = 0;
  private readonly capacity: number;

  constructor(capacity = 1000) {
    this.capacity = capacity;
    this.buf = new Array(capacity).fill(null);
  }

  push(event: TelemetryEvent): void {
    const idx = (this.head + this.count) % this.capacity;
    this.buf[idx] = event;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  drain(): TelemetryEvent[] {
    const result: TelemetryEvent[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      result.push(this.buf[idx]!);
      this.buf[idx] = null;
    }
    this.head = 0;
    this.count = 0;
    return result;
  }

  get size(): number {
    return this.count;
  }

  get empty(): boolean {
    return this.count === 0;
  }
}
