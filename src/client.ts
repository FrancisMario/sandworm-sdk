import { randomUUID } from 'crypto';
import { Transport, type TransportConfig } from './transport';
import type { ToolRegistration, MethodCallEvent, ErrorEvent } from './types';

const SDK_VERSION = '0.1.0';

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
    opts?: { description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> },
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
        this.emitMethodCall(name, performance.now() - start, 'ok');
        return result;
      } catch (err: any) {
        this.emitMethodCall(name, performance.now() - start, 'error', err?.message);
        this.emitError(name, err);
        throw err;
      }
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

  private emitMethodCall(method: string, durationMs: number, status: 'ok' | 'error', errorMessage?: string): void {
    const event: MethodCallEvent = {
      id: randomUUID(),
      type: 'method_call',
      timestamp: new Date().toISOString(),
      serviceName: this.config.serviceName,
      method,
      durationMs: Math.round(durationMs * 100) / 100,
      status,
      errorMessage,
    };
    this.transport.push(event);
  }

  private emitError(method: string, err: any): void {
    const event: ErrorEvent = {
      id: randomUUID(),
      type: 'error',
      timestamp: new Date().toISOString(),
      serviceName: this.config.serviceName,
      message: err?.message ?? String(err),
      stack: err?.stack,
      method,
    };
    this.transport.push(event);
  }
}
