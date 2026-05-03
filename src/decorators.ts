import type { ToolRegistration, PolicyHints } from './types';

const EXPOSE_KEY = Symbol.for('sandworm:expose');
const OBSERVE_KEY = Symbol.for('sandworm:observe');
const DENY_KEY = Symbol.for('sandworm:deny');

// ── Decorator metadata ──────────────────────────────────────────

export interface ExposeConfig {
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  policy?: PolicyHints;
}

export interface ExposeMetadata {
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  policy?: PolicyHints;
  propertyKey: string;
}

export interface ObserveMetadata {
  tags?: Record<string, string>;
  propertyKey: string;
}

// ── @expose decorator ───────────────────────────────────────────

export function expose(descriptionOrConfig?: string | ExposeConfig): MethodDecorator {
  return function (_target, propertyKey, descriptor: PropertyDescriptor) {
    const config = typeof descriptionOrConfig === 'string'
      ? { description: descriptionOrConfig }
      : descriptionOrConfig ?? {};

    const meta: ExposeMetadata = {
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: config.annotations,
      policy: config.policy,
      propertyKey: String(propertyKey),
    };

    // Store on the function itself (no reflect-metadata needed)
    (descriptor.value as any)[EXPOSE_KEY] = meta;

    return descriptor;
  };
}

// ── @observe decorator ──────────────────────────────────────────

export function observe(tags?: Record<string, string>): MethodDecorator {
  return function (_target, propertyKey, descriptor: PropertyDescriptor) {

    const meta: ObserveMetadata = {
      tags,
      propertyKey: String(propertyKey),
    };

    (descriptor.value as any)[OBSERVE_KEY] = meta;

    return descriptor;
  };
}

// ── @deny decorator ─────────────────────────────────────────────

export function deny(): MethodDecorator {
  return function (_target, _propertyKey, descriptor: PropertyDescriptor) {
    (descriptor.value as any)[DENY_KEY] = true;
    return descriptor;
  };
}

// ── Metadata readers ────────────────────────────────────────────

export function getExposeMetadata(fn: Function): ExposeMetadata | undefined {
  return (fn as any)[EXPOSE_KEY];
}

export function getObserveMetadata(fn: Function): ObserveMetadata | undefined {
  return (fn as any)[OBSERVE_KEY];
}

export function isDenied(fn: Function): boolean {
  return (fn as any)[DENY_KEY] === true;
}

export { EXPOSE_KEY, OBSERVE_KEY, DENY_KEY };
