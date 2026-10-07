// Studio Operator MCP server over stdio — for Claude Desktop, Claude Code and
// any local MCP client. It talks to a running Studio Operator instance (local
// or deployed) with a workspace agent token from Settings → Agent access.
//   STUDIO_API_URL   e.g. https://your-app.up.railway.app (default http://localhost:8787)
//   STUDIO_API_TOKEN so_agent_… (required)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, httpApi } from "./mcp";

const base = process.env.STUDIO_API_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const token = process.env.STUDIO_API_TOKEN;
if (!token) {
  console.error("STUDIO_API_TOKEN is required. Create one in Studio Operator → Settings → Agent access.");
  process.exit(1);
}
const server = createMcpServer(httpApi(base, token));
await server.connect(new StdioServerTransport());
// stdout is the protocol channel; log to stderr only.
console.error(`studio-operator MCP (stdio) → ${base}`);
