# @sandworm-ai/sdk

SDK for connecting your services to the Sandworm platform. Expose tools to AI agents without opening ports or running servers.

## Architecture

```
┌────────────┐   MCP (stdio/SSE)   ┌──────────────┐   WebSocket (outbound)   ┌─────────────────┐
│   Agent    │◄────────────────────►│   Sandworm   │◄───────────────────────►│  Your Service   │
│ (Claude,   │                      │   Platform   │                          │  (SDK, in VPC)  │
│  GPT, etc) │                      │  = MCP server│                          │  no ports open  │
└────────────┘                      └──────────────┘                          └─────────────────┘
```

- **Sandworm IS the MCP server.** Agents connect to us.
- **Your service connects outbound** via WebSocket — works behind VPCs, NATs, firewalls.
- **No ports to open**, no servers to run, no infrastructure to manage.

## Install

```bash
npm install @sandworm-ai/sdk
```

## Quick Start

```ts
import { Sandworm, expose, observe, TrustLevel, ApprovalRequirement } from '@sandworm-ai/sdk';

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
    // your refund logic
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
await sw.start(); // connects to Sandworm, registers tools, begins accepting calls
```

That's it. Your tools are now available to agents via the platform. The dashboard shows every call, enforces trust policies, and handles approvals.

## How It Works

1. `sw.start()` opens an outbound WebSocket to Sandworm
2. SDK registers all `@expose`d tools with their policy hints
3. When an agent calls a tool via MCP, Sandworm evaluates trust policy
4. If approved, the call is forwarded to your SDK over the WebSocket
5. SDK executes locally, returns the result
6. Sandworm relays it back to the agent

You never expose your service to the internet. All communication is initiated outbound.

## Decorators

### @expose — make a method callable by agents

```ts
import { expose, TrustLevel, ApprovalRequirement, CostCategory } from '@sandworm-ai/sdk';

class PaymentService {
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

  // Simple form — just a description
  @expose('Look up order status')
  async getStatus(args: { orderId: string }) {
    return { status: 'shipped' };
  }
}
```

Policy hints are **defaults** the dashboard adopts on first registration. Dashboard policy is authoritative — ops can override.

### @observe — trace without exposing to agents

```ts
class DataService {
  @observe()
  async fetchUser(id: string) {
    return db.users.findOne(id);
  }

  @observe({ tier: 'hot' })
  async getCachedConfig() {
    return redis.get('config');
  }
}
```

Observed methods get automatic timing, error tracking, and source-location capture.

### @deny — hard block from ever being exposed

```ts
class InternalService {
  @deny()
  async migrateDatabase() {
    // can NEVER be exposed — even if someone adds @expose later, it throws
  }
}
```

### scan — discover all decorated methods

```ts
sw.scan(new OrderService(), new DataService(), new InternalService());
```

## Imperative API

### wrapTool — register a tool without decorators

```ts
const search = sw.wrapTool('search', async (args: { query: string }) => {
  return { results: [] };
}, {
  description: 'Search documents',
  policy: { minTrustLevel: TrustLevel.L1, approval: ApprovalRequirement.Auto },
});

// Can still call directly (traced):
await search({ query: 'hello' });
```

### observe — trace a function without exposing

```ts
const fetchUser = sw.observe('fetchUser', async (id: string) => {
  return db.users.findOne(id);
});
```

### trackJob — background job lifecycle

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
  endpoint: 'https://api.sandworm.dev',  // Platform endpoint
  flushIntervalMs: 5000,          // Telemetry flush interval
  heartbeatIntervalMs: 30000,     // Keep-alive interval
  bufferCapacity: 1000,           // Max buffered events before flush
  debug: false,                   // Enable debug logging (or SANDWORM_DEBUG=1)
});
```

## Policy Hint Enums

```ts
import { TrustLevel, ApprovalRequirement, CostCategory } from '@sandworm-ai/sdk';

TrustLevel.L0  // No trust — fully blocked
TrustLevel.L1  // Minimal — read-only, no side effects
TrustLevel.L2  // Low — side effects with guardrails
TrustLevel.L3  // Medium — significant actions, may need approval
TrustLevel.L4  // High — full autonomy

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
| `job_complete` | Job finished successfully with duration |
| `job_fail` | Job failed with error and attempt number |
| `job_retry` | Job scheduled for retry with delay |
