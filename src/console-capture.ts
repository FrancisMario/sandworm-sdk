import { randomUUID } from 'crypto';
import type { LogEvent, LogLevel } from './types';

export interface CaptureLogsConfig {
  /** Which levels to capture (default: all) */
  levels?: LogLevel[];
  /** Keep printing to stdout/stderr (default: true) */
  passthrough?: boolean;
}

type LogHandler = (event: LogEvent) => void;

const METHOD_TO_LEVEL: Record<string, LogLevel> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

export class ConsoleCapture {
  private originals: Record<string, (...args: unknown[]) => void> = {};
  private active = false;
  private readonly levels: Set<LogLevel>;
  private readonly passthrough: boolean;
  private readonly serviceName: string;
  private readonly handler: LogHandler;

  constructor(
    serviceName: string,
    config: CaptureLogsConfig,
    handler: LogHandler,
  ) {
    this.serviceName = serviceName;
    this.levels = new Set(config.levels ?? ['debug', 'info', 'warn', 'error']);
    this.passthrough = config.passthrough ?? true;
    this.handler = handler;
  }

  install(): void {
    if (this.active) return;
    this.active = true;

    for (const method of METHODS) {
      const original = console[method].bind(console);
      this.originals[method] = original;

      console[method] = (...args: unknown[]) => {
        const level = METHOD_TO_LEVEL[method];
        if (this.levels.has(level)) {
          this.emit(level, args);
        }
        if (this.passthrough) {
          original(...args);
        }
      };
    }
  }

  uninstall(): void {
    if (!this.active) return;
    this.active = false;

    for (const method of METHODS) {
      if (this.originals[method]) {
        console[method] = this.originals[method] as any;
      }
    }
    this.originals = {};
  }

  private emit(level: LogLevel, args: unknown[]): void {
    const message = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');

    const source = this.captureSource();

    const event: LogEvent = {
      id: randomUUID(),
      type: 'log',
      timestamp: new Date().toISOString(),
      serviceName: this.serviceName,
      level,
      message,
      args: args.length > 1 || typeof args[0] !== 'string' ? serializeArgs(args) : undefined,
      sourceFile: source?.file,
      sourceLine: source?.line,
    };

    this.handler(event);
  }

  private captureSource(): { file: string; line: number } | undefined {
    const stack = new Error().stack;
    if (!stack) return undefined;
    const lines = stack.split('\n');
    // Skip: Error, this method, emit, console[method] wrapper
    for (const line of lines.slice(4)) {
      const match = line.match(/\((.+):(\d+):\d+\)/) ?? line.match(/at (.+):(\d+):\d+/);
      if (match && !match[1].includes('/sandworm-sdk/') && !match[1].includes('node_modules')) {
        return { file: match[1], line: parseInt(match[2], 10) };
      }
    }
    return undefined;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function serializeArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (a === null || a === undefined || typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') {
      return a;
    }
    try {
      // Ensure it's serializable — round-trip test
      return JSON.parse(JSON.stringify(a));
    } catch {
      return String(a);
    }
  });
}
