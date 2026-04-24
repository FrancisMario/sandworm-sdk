# sandworm

Observability SDK for MCP servers. Captures tool calls, errors, and performance data — sends them to [Sandworm](https://sandworm.lilicorp.dev).

## Install

```bash
npm install sandworm
```

## Quick Start

```ts
import { Sandworm } from 'sandworm';

const sw = new Sandworm({
  apiKey: 'sw_live_...',
  serviceName: 'my-mcp-server',
  endpoint: 'https://api.sandworm.lilicorp.dev',
});

// Wrap individual tool functions
const myTool = sw.wrapTool('searchDocs', async (args) => {
  // your tool logic
  return { results: [] };
});

// Or wrap an entire MCP server
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const server = new McpServer({ name: 'my-server', version: '1.0.0' });
sw.wrapMcpServer(server);

// Start (registers service + begins heartbeats)
await sw.start();

// On shutdown
await sw.shutdown();
```
