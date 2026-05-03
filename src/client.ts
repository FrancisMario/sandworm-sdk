import { randomUUID } from 'crypto';
import { Transport, type TransportConfig } from './transport';
import { registry, type RegisteredTool, type ObservedMethod } from './registry';
import type {
  ToolRegistration,
  PolicyHints,
  MethodCallEvent,
  ErrorEvent,
  LogEvent,
  LogLevel,
  JobStartEvent,
  JobCompleteEvent,
  JobFailEvent,
  JobRetryEvent,
} from './types';
import { ConsoleCapture, type CaptureLogsConfig } from './console-capture';

const SDK_VERSION = '0.4.0';

export interface SandwormConfig {
  /** API key (starts with sw_live_) */
  apiKey: string;
  /** Service name — identifies this service to the platform */
  serviceName?: string;
  /** Sandworm platform endpoint */
  endpoint?: string;
  /** Transport mode: 'sse' (default) or 'ws' */
  transport?: 'sse' | 'ws';
  /** Flush interval in ms (default: 5000) */
  flushIntervalMs?: number;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Event buffer capacity (default: 1000) */
  bufferCapacity?: number;
  /** Enable debug logging (default: false, or set SANDWORM_DEBUG=1) */
  debug?: boolean;
  /**
   * Capture console.log/warn/error/info/debug and stream as events.
   * - `true` — capture all levels
   * - `{ levels, passthrough }` — fine-grained control
   */
  captureLogs?: boolean | CaptureLogsConfig;
}

export interface ObserveOptions {
  /** Tags attached to every event from this method */
  tags?: Record<string, string>;
}

export interface WrapToolOptions {
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  policy?: PolicyHints;
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
  private readonly config: Required<Pick<SandwormConfig, 'apiKey' | 'serviceName'>> & SandwormConfig;
  private readonly transport: Transport;
  private readonly tools: ToolRegistration[] = [];
  private readonly instanceId = randomUUID();
  private consoleCapture: ConsoleCapture | null = null;
  private started = false;

  constructor(config: SandwormConfig) {
    const serviceName = config.serviceName ?? 'default';
    this.config = { ...config, serviceName };
    const debug = config.debug ?? !!process.env.SANDWORM_DEBUG;
    const transportConfig: TransportConfig = {
      endpoint: config.endpoint ?? 'https://api.sandworm.dev',
      apiKey: config.apiKey,
      serviceName,
      instanceId: this.instanceId,
      flushIntervalMs: config.flushIntervalMs ?? 5_000,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30_000,
      bufferCapacity: config.bufferCapacity ?? 1_000,
      transport: config.transport ?? 'sse',
      debug,
    };
    this.transport = new Transport(transportConfig);

    // Handle inbound tool_call requests from the platform
    this.transport.on('tool_call', (msg: { id: string; tool: string; args: unknown }) => {
      this.handleToolCall(msg.id, msg.tool, msg.args);
    });

    // Console log capture
    if (config.captureLogs) {
      const captureConfig: CaptureLogsConfig =
        config.captureLogs === true ? {} : config.captureLogs;
      this.consoleCapture = new ConsoleCapture(serviceName, captureConfig, (event) => {
        this.transport.push(event);
      });
      this.consoleCapture.install();
    }

    if (debug) {
      console.log(`[sandworm] instance=${this.instanceId.slice(0, 8)} service="${serviceName}"`);
    }
  }

  /**
   * Scan class instances for @expose and @observe decorated methods.
   * Exposed methods become tools available to agents via the platform.
   * Observed methods get automatic tracing.
   */
  scan(...instances: object[]): this {
    for (const instance of instances) {
      registry.scan(instance);

      // Wrap observed methods with telemetry
      for (const observed of registry.getAllObserved()) {
        this.wrapObservedMethod(observed);
      }

      // Collect tool registrations from exposed methods
      for (const tool of registry.getAllTools()) {
        if (!this.tools.find((t) => t.name === tool.name)) {
          this.tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
            policyHints: tool.policyHints,
          });
        }
      }
    }
    return this;
  }

  /**
   * Wrap a tool function — registers it as callable by agents.
   * Returns a function you can also call directly (traced either way).
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
      policyHints: opts?.policy,
    });

    // Register in registry so tool_call can find it
    registry.register({
      name,
      description: opts?.description,
      inputSchema: opts?.inputSchema,
      annotations: opts?.annotations,
      policyHints: opts?.policy,
      handler: handler as any,
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
   * Unlike wrapTool, this does NOT register as a tool callable by agents.
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
   * Connect to the Sandworm platform and begin accepting tool calls.
   * Establishes a persistent WebSocket, registers tools, starts heartbeats.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.transport.connect(this.tools);
  }

  /**
   * Flush pending events and disconnect.
   */
  async shutdown(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.consoleCapture?.uninstall();
    await this.transport.shutdown();
  }

  // ── Inbound tool execution ──────────────────────────────────────────

  private async handleToolCall(callId: string, toolName: string, args: unknown): Promise<void> {
    const tool = registry.getTool(toolName);
    if (!tool) {
      this.transport.sendToolResult(callId, null, `Unknown tool: ${toolName}`, 0);
      return;
    }

    const start = performance.now();
    try {
      const result = await tool.handler(args);
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      this.emitMethodCall(toolName, durationMs, 'ok');
      this.transport.sendToolResult(callId, result, undefined, durationMs);
    } catch (err: any) {
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      this.emitMethodCall(toolName, durationMs, 'error', err?.message);
      this.emitError(toolName, err);
      this.transport.sendToolResult(callId, null, err?.message ?? 'Unknown error', durationMs);
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private wrapObservedMethod(observed: ObservedMethod): void {
    const original = observed.handler;
    const self = this;
    observed.handler = async function (...args: any[]) {
      const start = performance.now();
      try {
        const result = await original(...args);
        self.emitMethodCall(observed.name, performance.now() - start, 'ok', undefined, observed.tags);
        return result;
      } catch (err: any) {
        self.emitMethodCall(observed.name, performance.now() - start, 'error', err?.message, observed.tags);
        self.emitError(observed.name, err, observed.tags);
        throw err;
      }
    };
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

  private captureSource(): { file: string; line: number } | undefined {
    const stack = new Error().stack;
    if (!stack) return undefined;
    const lines = stack.split('\n');
    for (const line of lines.slice(4)) {
      const match = line.match(/\((.+):(\d+):\d+\)/) ?? line.match(/at (.+):(\d+):\d+/);
      if (match && !match[1].includes('/sandworm-sdk/') && !match[1].includes('node_modules')) {
        return { file: match[1], line: parseInt(match[2], 10) };
      }
    }
    return undefined;
  }
}
