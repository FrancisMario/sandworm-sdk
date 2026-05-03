// Core
export { Sandworm } from './client';
export type { SandwormConfig, ObserveOptions, WrapToolOptions, JobHandle } from './client';

// Decorators
export { expose, observe, deny } from './decorators';
export type { ExposeMetadata, ExposeConfig, ObserveMetadata } from './decorators';

// Registry (advanced)
export { registry } from './registry';
export type { RegisteredTool, ObservedMethod } from './registry';

// Transport (advanced)
export { Transport } from './transport';
export type { TransportConfig, InboundMessage, OutboundMessage } from './transport';
export { EventBuffer } from './buffer';

// Types
export {
  TrustLevel,
  ApprovalRequirement,
  CostCategory,
} from './types';
export type {
  PolicyHints,
  ToolRegistration,
  RuntimeMetrics,
  TelemetryEvent,
  MethodCallEvent,
  ErrorEvent,
  LogEvent,
  LogLevel,
  JobStartEvent,
  JobCompleteEvent,
  JobFailEvent,
  JobRetryEvent,
  EventType,
} from './types';

// Console capture (advanced)
export { ConsoleCapture } from './console-capture';
export type { CaptureLogsConfig } from './console-capture';
