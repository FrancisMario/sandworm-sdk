/** Wire types matching the ingest API contract */

// ── Policy hint enums ───────────────────────────────────────────

export enum TrustLevel {
  L0 = 0,
  L1 = 1,
  L2 = 2,
  L3 = 3,
  L4 = 4,
}

export enum ApprovalRequirement {
  Auto = 'auto',
  Human = 'human',
  Conditional = 'conditional',
}

export enum CostCategory {
  Free = 'free',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

export interface PolicyHints {
  minTrustLevel?: TrustLevel;
  approval?: ApprovalRequirement;
  reversible?: boolean;
  cost?: CostCategory;
  tags?: string[];
}

// ── Registration types ──────────────────────────────────────────

export interface ToolRegistration {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  policyHints?: PolicyHints;
}

export interface RegisterRequest {
  serviceName: string;
  instanceId: string;
  sdkVersion: string;
  tools: ToolRegistration[];
}

export interface IngestEventsRequest {
  events: TelemetryEvent[];
}

export interface RuntimeMetrics {
  memoryRss: number;
  memoryHeapUsed: number;
  memoryHeapTotal: number;
  memoryExternal: number;
  cpuPercent: number;
  uptimeSeconds: number;
  eventLoopLagMs: number;
}

export interface HeartbeatRequest {
  serviceName: string;
  instanceId: string;
  metrics?: RuntimeMetrics;
}

// Events

export type EventType = 'method_call' | 'error' | 'log' | 'job_start' | 'job_complete' | 'job_fail' | 'job_retry';

export interface BaseEvent {
  id: string;
  type: EventType;
  timestamp: string;
  serviceName: string;
  tags?: Record<string, string>;
}

export interface MethodCallEvent extends BaseEvent {
  type: 'method_call';
  method: string;
  durationMs: number;
  status: 'ok' | 'error';
  errorMessage?: string;
  sourceFile?: string;
  sourceLine?: number;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  message: string;
  stack?: string;
  method?: string;
  sourceFile?: string;
  sourceLine?: number;
}

export interface JobStartEvent extends BaseEvent {
  type: 'job_start';
  jobId: string;
  jobType: string;
}

export interface JobCompleteEvent extends BaseEvent {
  type: 'job_complete';
  jobId: string;
  jobType: string;
  durationMs: number;
}

export interface JobFailEvent extends BaseEvent {
  type: 'job_fail';
  jobId: string;
  jobType: string;
  errorMessage: string;
  errorStack?: string;
  attemptNumber: number;
}

export interface JobRetryEvent extends BaseEvent {
  type: 'job_retry';
  jobId: string;
  jobType: string;
  attemptNumber: number;
  retryDelayMs?: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent extends BaseEvent {
  type: 'log';
  level: LogLevel;
  message: string;
  args?: unknown[];
  sourceFile?: string;
  sourceLine?: number;
}

export type TelemetryEvent =
  | MethodCallEvent
  | ErrorEvent
  | LogEvent
  | JobStartEvent
  | JobCompleteEvent
  | JobFailEvent
  | JobRetryEvent;
