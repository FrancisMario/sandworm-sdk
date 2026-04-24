# @sandworm-ai/sdk

AI observability SDK — decorators, tool tracing, job lifecycle, built-in MCP server, agent proxy.

## Install

```bash
npm install @sandworm-ai/sdk
```

## Quick Start

```ts
import { Sandworm, expose, observe } from '@sandworm-ai/sdk';

class SearchService {
  @expose('Search the documentation')
  async search(args: { query: string }) {
    return { results: ['result 1', 'result 2'] };
  }

  @observe()
  async indexDocument(doc: { id: string; content: string }) {
    // your indexing logic
  }
}

const sw = new Sandworm({ apiKey: 'sw_live_...' });
sw.scan(new SearchService());
await sw.start();
```

That's it. `@expose` methods become MCP tools. `@observe` methods get automatic tracing. Everything registers with the platform on `start()`.

## Decorators

### @expose — register as an MCP tool

```ts
class OrderService {
  @expose('Retry a failed order')
  async retryOrder(args: { orderId: string }) {
    return { success: true };
  }

  @expose({ description: 'Cancel order', annotations: { destructiveHint: true } })
  async cancelOrder(args: { orderId: string; reason: string }) {
    return { cancelled: true };
  }
}
```

Tools are named `ClassName.methodName` (e.g. `OrderService.retryOrder`). Every call is traced with timing, status, and errors.

### @observe — trace without exposing as a tool

```ts
class DataService {
  @observe()
  async fetchUser(id: string) {
    return db.users.findOne(id);
  }

  @observe({ cache: 'redis' })
  async getCachedConfig() {
    return redis.get('config');
  }
}
```

### scan — discover decorated methods

```ts
const sw = new Sandworm({ apiKey: '...' });
sw.scan(new OrderService(), new DataService());
await sw.start();
```

## Imperative API

For functional code or partial adoption — no decorators needed.

### wrapTool

```ts
const search = sw.wrapTool('search', async (args: { query: string }) => {
  return { results: [] };
}, { description: 'Search docs' });

await search({ query: 'hello' });
```

### observe (function)

```ts
const fetchUser = sw.observe('fetchUser', async (id: string) => {
  return db.users.findOne(id);
});
```

### wrapMcpServer

Instrument an existing `@modelcontextprotocol/sdk` server:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
sw.wrapMcpServer(server);
```

### trackJob

```ts
const job = sw.trackJob('email-send');
try {
  await sendEmail(payload);
  job.complete();
} catch (err) {
  job.fail(err);
  job.retry(2, 5000);
}
```

## Built-in MCP Server

Start a full MCP server from scanned `@expose` methods — no MCP SDK knowledge needed:

```ts
const sw = new Sandworm({ apiKey: '...' });
sw.scan(new OrderService(), new SearchService());
await sw.startMcpServer();
```

This starts a stdio MCP server with all exposed tools, plus telemetry and heartbeats.

## Configuration

```ts
new Sandworm({
  apiKey: 'sw_live_...',       // Required — everything else has defaults
  serviceName: 'my-service',   // Default: "default"
  endpoint: '...',             // Default: https://api.sandworm.lilicorp.dev
  flushIntervalMs: 5000,       // Default: 5s
  heartbeatIntervalMs: 30000,  // Default: 30s
  bufferCapacity: 1000,        // Default: 1000
  debug: false,                // Default: false (or SANDWORM_DEBUG=1)
});
```

Only `apiKey` is required. Everything else has sensible defaults.

## Event Types

| Type | Description |
|------|-------------|
| `method_call` | Tool/function call with timing and status |
| `error` | Error with stack trace and source location |
| `job_start` | Background job started |
| `job_complete` | Job finished successfully with duration |
| `job_fail` | Job failed with error and attempt number |
| `job_retry` | Job scheduled for retry with delay |
