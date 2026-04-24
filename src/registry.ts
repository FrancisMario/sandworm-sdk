import type { ToolRegistration } from './types';
import { getExposeMetadata, getObserveMetadata, type ExposeMetadata, type ObserveMetadata } from './decorators';

export interface RegisteredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  handler: (args: any) => Promise<any>;
}

export interface ObservedMethod {
  name: string;
  tags?: Record<string, string>;
  handler: (...args: any[]) => Promise<any>;
}

class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private observed = new Map<string, ObservedMethod>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`[sandworm] Duplicate tool name: "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
  }

  addObserved(method: ObservedMethod): void {
    this.observed.set(method.name, method);
  }

  /**
   * Scan a class instance for @expose and @observe decorated methods.
   * Returns the names of discovered methods.
   */
  scan(instance: object): { exposed: string[]; observed: string[] } {
    const proto = Object.getPrototypeOf(instance);
    const className = proto.constructor.name;
    const exposedNames: string[] = [];
    const observedNames: string[] = [];

    const propertyNames = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor');

    for (const key of propertyNames) {
      const method = (instance as any)[key];
      if (typeof method !== 'function') continue;

      const exposeMeta = getExposeMetadata(proto[key]);
      const observeMeta = getObserveMetadata(proto[key]);

      if (exposeMeta) {
        const toolName = `${className}.${key}`;
        this.register({
          name: toolName,
          description: exposeMeta.description,
          inputSchema: exposeMeta.inputSchema,
          annotations: exposeMeta.annotations,
          handler: method.bind(instance),
        });
        exposedNames.push(toolName);
      }

      if (observeMeta) {
        const methodName = `${className}.${key}`;
        this.addObserved({
          name: methodName,
          tags: observeMeta.tags,
          handler: method.bind(instance),
        });
        observedNames.push(methodName);
      }
    }

    return { exposed: exposedNames, observed: observedNames };
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  getAllTools(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  getToolRegistrations(): ToolRegistration[] {
    return this.getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));
  }

  getAllObserved(): ObservedMethod[] {
    return [...this.observed.values()];
  }

  get toolCount(): number {
    return this.tools.size;
  }

  get observedCount(): number {
    return this.observed.size;
  }

  clear(): void {
    this.tools.clear();
    this.observed.clear();
  }
}

export const registry = new ToolRegistry();
