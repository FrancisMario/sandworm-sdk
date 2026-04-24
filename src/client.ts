import { randomUUID } from 'crypto';
import { Transport, type TransportConfig } from './transport';
import type {
  ToolRegistration,
  MethodCallEvent,
  ErrorEvent,
  JobStartEvent,
  JobCompleteEvent,
  JobFailEvent,
  JobRetryEvent,
} from './types';

const SDK_VERSION = '0.2.0';

export interface SandwormConfig {
  /** API key (starts with sw_live_) */
  apiKey: string;
  /** Name of this service / MCP server */
  serviceName: string;
  /** Sandworm API endpoint */
  endpoint?: string;
  /** Flush interval in ms (default: 5000) */
  flushIntervalMs?: number;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Event buffer capacity (default: 1000) */
  bufferCapacity?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
}

export interface ObserveOptions {
  /** Tags attached to every event from this method */
  tags?: Record<string, string>;
}

export interface WrapToolOptions {
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export interface JobHandle {
  /** Mark the job as completed */
  complete(): void;
  /** Mark the job as failed */
  fail(error: string | Error, attemptNumber?: number): void;
  /** Mark the job as retrying */
  retry(attemptNumber: number, delayMs?: number): void;
}

export class Sandworm {
  private readonly config: SandwormConfig;
  private readonly transport: Transport;
  private readonly tools: ToolRegistration[] = [];
  private started = false;

  constructor(config: SandwormConfig) {
    this.config = config;
    const transportConfig: TransportConfig = {
      endpoint: config.endpoint ?? 'https://api.sandworm.lilicorp.dev',
      apiKey: config.apiKey,
      serviceName: config.serviceName,
      flushIntervalMs: config.flushIntervalMs ?? 5_000,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30_000,
      bufferCapacity: config.bufferCapacity ?? 1_000,
      debug: config.debug ?? !!process.env.SANDWORM_DEBUG,
    };
    this.transport = new Transport(transportConfig);
  }

  /**
   * Wrap a tool function with automatic tracing.
   * Returns a new function with the same signature.
   */
  wrapTool<TArgs, TResult>(
    name: string,
    handler: (args: TArgs) => Promise<TResult>,
    opts?: WrapToolOptions,
  ): (args: TArgs) => Promise<TResult> {
    this.tools.push({
      name,
      description: opts?.description,
      inputSchema: opts?.inputSchema,
      annotations: opts?.annotations,
    });

    return async (args: TArgs): Promise<TResult> => {
      const start = performance.now();
      try {
        const result = await handler(args);
        this.emitMethodCall(name, performance.now() - start, 'ok', undefined, opts?.tags);
        return result;
      } catch (err: any) {
        this.emitMethodCall(name, performance.now() - start, 'error', err?.message, opts?.tags);
        this.emitError(name, err, opts?.tags);
        throw err;
      }
    };
  }

  /**
   * Wrap any async function with observability (timing, errors).
   * Unlike wrapTool, this does NOT register as an MCP tool.
   */
  observe<TArgs extends any[], TResult>(
    name: string,
    fn: (...args: TArgs) => Promise<TResult>,
    opts?: ObserveOptions,
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
      const start = performance.now();
      try {
        const result = await fn(...args);
        this.emitMethodCall(name, performance.now() - start, 'ok', undefined, opts?.tags);
        return result;
      } catch (err: any) {
        this.emitMethodCall(name, performance.now() - start, 'error', err?.message, opts?.tags);
        this.emitError(name, err, opts?.tags);
        throw err;
      }
    };
  }

  /**
   * Track a background job's lifecycle (start → complete/fail/retry).
   * Returns a handle to mark state transitions.
   */
  trackJob(jobType: string, jobId?: string, tags?: Record<string, string>): JobHandle {
    const id = jobId ?? randomUUID();
    const startTime = performance.now();

    const startEvent: JobStartEvent = {
      id: randomUUID(),
      type: 'job_start',
      timestamp: new Date().toISOString(),
      serviceName: this.config.serviceName,
      jobId: id,
      jobType,
      tags,
    };
    this.transport.push(startEvent);

    return {
      complete: () => {
        const event: JobCompleteEvent = {
          id: randomUUID(),
          type: 'job_complete',
          timestamp: new Date().toISOString(),
          serviceName: this.config.serviceName,
          jobId: id,
          jobType,
          durationMs: Math.round((performance.now() - startTime) * 100) / 100,
          tags,
        };
        this.transport.push(event);
      },
      fail: (error: string | Error, attemptNumber = 1) => {
        const msg = error instanceof Error ? error.message : error;
        const stack = error instanceof Error ? error.stack : undefined;
        const event: JobFailEvent = {
          id: randomUUID(),
          type: 'job_fail',
          timestamp: new Date().toISOString(),
          serviceName: this.config.serviceName,
          jobId: id,
          jobType,
          errorMessage: msg,
          errorStack: stack,
          attemptNumber,
          tags,
        };
        this.transport.push(event);
      },
      retry: (attemptNumber: number, delayMs?: number) => {
        const event: JobRetryEvent = {
          id: randomUUID(),
          type: 'job_retry',
          timestamp: new Date().toISOString(),
          serviceName: this.config.serviceName,
          jobId: id,
          jobType,
          attemptNumber,
          retryDelayMs: delayMs,
          tags,
        };
        this.transport.push(event);
      },
    };
  }

  /**
   * Wrap an MCP server instance to automatically trace all tool calls.
   * Monkey-patches server.tool() to intercept registrations.
   */
  wrapMcpServer(server: any): void {
    const originalTool = server.tool.bind(server);
    const self = this;

    server.tool = function (...toolArgs: any[]) {
      // MCP SDK tool() signature: (name, description?, schema?, handler)
      // or (name, schema?, handler) — find the handler (last function arg)
      const handlerIdx = toolArgs.findIndex((a: any) => typeof a === 'function');
      if (handlerIdx === -1) return originalTool(...toolArgs);

      const name = toolArgs[0] as string;
      const originalHandler = toolArgs[handlerIdx];

      const wrappedHandler = async function (this: any, ...args: any[]) {
        const start = performance.now();
        try {
          const result = await originalHandler.apply(this, args);
          self.emitMethodCall(name, performance.now() - start, 'ok');
          return result;
        } catch (err: any) {
          self.emitMethodCall(name, performance.now() - start, 'error', err?.message);
          self.emitError(name, err);
          throw err;
        }
      };

      // Extract tool metadata for registration
      const description = typeof toolArgs[1] === 'string' ? toolArgs[1] : undefined;
      let inputSchema: Record<string, unknown> | undefined;
      for (let i = 1; i < handlerIdx; i++) {
        if (typeof toolArgs[i] === 'object' && toolArgs[i] !== null) {
          inputSchema = toolArgs[i];
          break;
        }
      }

      self.tools.push({ name, description, inputSchema });

      toolArgs[handlerIdx] = wrappedHandler;
      return originalTool(...toolArgs);
    };
  }

  /**
   * Register with the ingest API and start heartbeat + flush loops.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.transport.register({
      serviceName: this.config.serviceName,
      sdkVersion: SDK_VERSION,
      tools: this.tools,
    });

    this.transport.start();
  }

  /**
   * Flush pending events and stop background loops.
   */
  async shutdown(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.transport.shutdown();
  }

  private emitMethodCall(method: string, durationMs: number, status: 'ok' | 'error', errorMessage?: string, tags?: Record<string, string>): void {
    const source = this.captureSource();
    const event: MethodCallEvent = {
      id: randomUUID(),
      type: 'method_call',
      timestamp: new Date().toISOString(),
      serviceName: this.config.serviceName,
      method,
      durationMs: Math.round(durationMs * 100) / 100,
      status,
      errorMessage,
      sourceFile: source?.file,
      sourceLine: source?.line,
      tags,
    };
    this.transport.push(event);
  }

  private emitError(method: string, err: any, tags?: Record<string, string>): void {
    const source = this.captureSource();
    const event: ErrorEvent = {
      id: randomUUID(),
      type: 'error',
      timestamp: new Date().toISOString(),
      serviceName: this.config.serviceName,
      message: err?.message ?? String(err),
      stack: err?.stack,
      method,
      sourceFile: source?.file,
      sourceLine: source?.line,
      tags,
    };
    this.transport.push(event);
  }

  /** Extract caller file/line from stack trace (skips SDK internals) */
  private captureSource(): { file: string; line: number } | undefined {
    const stack = new Error().stack;
    if (!stack) return undefined;
    const lines = stack.split('\n');
    // Skip: Error, this method, emitMethodCall/emitError, the SDK wrapper
    for (const line of lines.slice(4)) {
      const match = line.match(/\((.+):(\d+):\d+\)/) ?? line.match(/at (.+):(\d+):\d+/);
      if (match && !match[1].includes('/sandworm-sdk/') && !match[1].includes('node_modules')) {
        return { file: match[1], line: parseInt(match[2], 10) };
      }
    }
    return undefined;
  }
}
