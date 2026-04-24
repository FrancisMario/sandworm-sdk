// Core
export { Sandworm } from './client';
export type { SandwormConfig, ObserveOptions, WrapToolOptions, JobHandle } from './client';

// Decorators
export { expose, observe } from './decorators';
export type { ExposeMetadata, ObserveMetadata } from './decorators';

// Registry
export { registry } from './registry';
export type { RegisteredTool, ObservedMethod } from './registry';

// MCP server
export { createMcpServer } from './server';

// Transport (advanced)
export { Transport } from './transport';
export type { TransportConfig } from './transport';
export { EventBuffer } from './buffer';

// Types
export type {
  ToolRegistration,
  TelemetryEvent,
  MethodCallEvent,
  ErrorEvent,
  JobStartEvent,
  JobCompleteEvent,
  JobFailEvent,
  JobRetryEvent,
  EventType,
} from './types';
