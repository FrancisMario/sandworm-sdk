import { registry } from './registry';

/**
 * Creates an MCP server from the tool registry.
 * Requires @modelcontextprotocol/sdk as a peer dependency.
 */
export async function createMcpServer(config?: { name?: string; version?: string; instructions?: string }) {
  let McpServer: any;
  let StdioServerTransport: any;

  try {
    const mcpMod = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const stdioMod = await import('@modelcontextprotocol/sdk/server/stdio.js');
    McpServer = mcpMod.McpServer;
    StdioServerTransport = stdioMod.StdioServerTransport;
  } catch {
    throw new Error(
      '[sandworm] @modelcontextprotocol/sdk is required for MCP server. Install it: npm install @modelcontextprotocol/sdk',
    );
  }

  const server = new McpServer(
    {
      name: config?.name ?? 'sandworm',
      version: config?.version ?? '1.0.0',
    },
    config?.instructions ? { instructions: config.instructions } : undefined,
  );

  for (const tool of registry.getAllTools()) {
    const args: any[] = [tool.name];
    if (tool.description) args.push(tool.description);
    if (tool.inputSchema) args.push(tool.inputSchema);

    args.push(async (toolArgs: any) => {
      const result = await tool.handler(toolArgs);
      // MCP expects { content: [...] } response format
      if (result && typeof result === 'object' && 'content' in result) {
        return result;
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });

    server.tool(...args);
  }

  return {
    server,
    async start() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
    async close() {
      await server.close();
    },
  };
}
