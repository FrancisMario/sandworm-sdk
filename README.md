# @sandworm-ai/sdk

AI observability SDK — tool call tracing, job lifecycle, error capture, MCP server instrumentation.

## Install

```bash
npm install @sandworm-ai/sdk
```

## Quick Start

```ts
import { Sandworm } from '@sandworm-ai/sdk';

const sw = new Sandworm({
  apiKey: 'sw_live_...',
  serviceName: 'my-service',
  endpoint: 'https://api.sandworm.lilicorp.dev',
});

await sw.start();
```

## Features

### Wrap MCP Tools

Register tools with automatic tracing — every call records timing, status, and errors.

```ts
const search = sw.wrapTool('searchDocs', async (args: { query: string }) => {
  return { results: [] };
}, {
  description: 'Search documentation',
  tags: { domain: 'search' },
});

const result = await search({ query: 'hello' });
```

### Wrap MCP Servers

Instrument an entire `@modelcontextprotocol/sdk` server. All tools registered after wrapping are automatically traced.

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
sw.wrapMcpServer(server);

// Tools registered after this are automatically traced
server.tool('search', { query: z.string() }, async ({ query }) => {
  return { content: [{ type: 'text', text: 'results...' }] };
});
```

### Observe Any Function

Wrap any async function with timing/error capture — no MCP registration.

```ts
const fetchUser = sw.observe('fetchUser', async (id: string) => {
  return db.users.findOne(id);
}, { tags: { layer: 'data' } });

const user = await fetchUser('usr_123');
```

### Track Job Lifecycle

Monitor background jobs through their full lifecycle: start → complete/fail/retry.

```ts
const job = sw.trackJob('email-send', 'job_abc');

try {
  await sendEmail(payload);
  job.complete();
} catch (err) {
  job.fail(err, 1);
  job.retry(2, 5000); // attempt 2, 5s delay
}
```

### Source Location Capture

Every event automatically includes the source file and line number from your application code, giving agents precise context for debugging.

### Custom Tags

Attach metadata to any traced function or job for filtering and grouping in reports.

```ts
sw.observe('processOrder', handler, {
  tags: { queue: 'high-priority', region: 'us-east-1' },
});
```

## Configuration

```ts
new Sandworm({
  apiKey: 'sw_live_...',          // Required
  serviceName: 'my-service',      // Required
  endpoint: 'https://api.sandworm.lilicorp.dev', // Default
  flushIntervalMs: 5000,          // Event flush interval (default: 5s)
  heartbeatIntervalMs: 30000,     // Heartbeat interval (default: 30s)
  bufferCapacity: 1000,           // Ring buffer size (default: 1000)
  debug: false,                   // Debug logging (or set SANDWORM_DEBUG=1)
});
```

## Lifecycle

```ts
await sw.start();      // Registers service + tools, starts heartbeat/flush loops
// ... app runs ...
await sw.shutdown();   // Flushes pending events, stops loops
```

## Event Types

| Type | Description |
|------|-------------|
| `method_call` | Tool/function call with timing and status |
| `error` | Error with stack trace and source location |
| `job_start` | Background job started |
| `job_complete` | Job finished successfully with duration |
| `job_fail` | Job failed with error and attempt number |
| `job_retry` | Job scheduled for retry with delay |
