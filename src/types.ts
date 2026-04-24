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

export type EventType = 'method_call' | 'error';

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
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  message: string;
  stack?: string;
  method?: string;
}

export type TelemetryEvent = MethodCallEvent | ErrorEvent;
