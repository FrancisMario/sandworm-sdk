/** Wire types matching the ingest API contract */

export interface ToolRegistration {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface RegisterRequest {
  serviceName: string;
  sdkVersion: string;
  tools: ToolRegistration[];
}

export interface IngestEventsRequest {
  events: TelemetryEvent[];
}

export interface HeartbeatRequest {
  serviceName: string;
}

// Events

export type EventType = 'method_call' | 'error' | 'job_start' | 'job_complete' | 'job_fail' | 'job_retry';

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

export type TelemetryEvent =
  | MethodCallEvent
  | ErrorEvent
  | JobStartEvent
  | JobCompleteEvent
  | JobFailEvent
  | JobRetryEvent;
