# @sandworm-ai/sdk

Node.js SDK for the Sandworm platform. Connects your services to the control plane via outbound WebSocket — decorated methods become tools that agents can call through MCP.

## Install

```bash
npm install @sandworm-ai/sdk
```

## Architecture

```
┌────────────┐   MCP (stdio/SSE)   ┌──────────────┐   WebSocket (outbound)   ┌─────────────────┐
│   Agent    │◄────────────────────►│   Sandworm   │◄───────────────────────►│  Your Service   │
│ (Claude,   │                      │   Platform   │                          │  (SDK, in VPC)  │
│  GPT, etc) │                      │  = MCP server│                          │                 │
└────────────┘                      └──────────────┘                          └─────────────────┘
```

- The platform acts as the MCP server. Agents connect to it.
- Your service connects outbound via WebSocket. Works behind NAT/firewalls — no open ports needed.
- Tool calls are forwarded from the platform to your SDK over the socket.

## Quick Start

```ts
import { Sandworm, expose, observe, TrustLevel, ApprovalRequirement, CostCategory } from '@sandworm-ai/sdk';

class OrderService {
  @expose({
    description: 'Refund an order',
    policy: {
      minTrustLevel: TrustLevel.L2,
      approval: ApprovalRequirement.Conditional,
      cost: CostCategory.Medium,
      reversible: false,
    },
  })
  async refundOrder(args: { orderId: string; amount: number }) {
    return { success: true, refundId: 'ref_123' };
  }

  @observe()
  async getOrder(id: string) {
    return db.orders.findOne(id);
  }
}

const sw = new Sandworm({
  apiKey: 'sw_live_...',
  serviceName: 'order-service',
});

sw.scan(new OrderService());
await sw.start();
```

## How It Works

1. `sw.start()` opens an outbound WebSocket to the platform
2. The SDK registers all `@expose`d methods with their schemas and policy hints
3. When an agent calls a tool via MCP, the platform evaluates trust policy
4. If approved, the call is forwarded to your SDK over the WebSocket
5. The SDK executes locally and returns the result
6. The platform relays it back to the agent

## Decorators

### @expose

Marks a method as callable by agents. Accepts a description string or a config object with policy hints.

```ts
@expose({
  description: 'Process a refund',
  policy: {
    minTrustLevel: TrustLevel.L3,
    approval: ApprovalRequirement.Human,
    reversible: false,
    cost: CostCategory.High,
    tags: ['financial', 'destructive'],
  },
})
async refund(args: { orderId: string; amount: number }) {
  return { success: true };
}

// Short form
@expose('Look up order status')
async getStatus(args: { orderId: string }) {
  return { status: 'shipped' };
}
```

Policy hints are defaults adopted on first registration. Dashboard policy is authoritative — can be overridden by ops.

### @observe

Traces a method (timing, errors, source location) without exposing it to agents.

```ts
@observe()
async fetchUser(id: string) {
  return db.users.findOne(id);
}

@observe({ tier: 'hot' })
async getCachedConfig() {
  return redis.get('config');
}
```

### @deny

Prevents a method from ever being exposed, even if `@expose` is added later.

```ts
@deny()
async migrateDatabase() { ... }
```

### scan

Discovers all decorated methods on one or more class instances.

```ts
sw.scan(new OrderService(), new DataService(), new InternalService());
```

## Imperative API

### wrapTool

Register a tool without decorators:

```ts
const search = sw.wrapTool('search', async (args: { query: string }) => {
  return { results: [] };
}, {
  description: 'Search documents',
  policy: { minTrustLevel: TrustLevel.L1, approval: ApprovalRequirement.Auto },
});

await search({ query: 'hello' }); // direct calls are also traced
```

### observe (function)

Trace a function without exposing it:

```ts
const fetchUser = sw.observe('fetchUser', async (id: string) => {
  return db.users.findOne(id);
});
```

### trackJob

Track background job lifecycle:

```ts
const job = sw.trackJob('email-send');
try {
  await sendEmail(payload);
  job.complete();
} catch (err) {
  job.fail(err);
}
```

## Configuration

```ts
new Sandworm({
  apiKey: 'sw_live_...',          // Required
  serviceName: 'my-service',      // Identifies this service (default: "default")
  endpoint: 'https://...',        // Platform endpoint
  flushIntervalMs: 5000,          // Telemetry flush interval
  heartbeatIntervalMs: 30000,     // Keep-alive interval
  bufferCapacity: 1000,           // Max buffered events before flush
  debug: false,                   // Debug logging (or SANDWORM_DEBUG=1)
});
```

## Enums

```ts
TrustLevel.L0  // Blocked
TrustLevel.L1  // Read-only, no side effects
TrustLevel.L2  // Side effects with guardrails
TrustLevel.L3  // Significant actions, may need approval
TrustLevel.L4  // Full autonomy

ApprovalRequirement.Auto         // Platform decides based on trust level
ApprovalRequirement.Human        // Always requires human approval
ApprovalRequirement.Conditional  // Approval based on runtime conditions

CostCategory.Free    // No cost
CostCategory.Low     // < $1
CostCategory.Medium  // $1–$100
CostCategory.High    // > $100
```

## Event Types

| Type | Description |
|------|-------------|
| `method_call` | Tool/function call with timing and status |
| `error` | Error with stack trace and source location |
| `job_start` | Background job started |
| `job_complete` | Job finished with duration |
| `job_fail` | Job failed with error and attempt count |
| `job_retry` | Job scheduled for retry with delay |

## License

MIT
