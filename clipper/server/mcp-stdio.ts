// Clip Operator MCP server over stdio — for Claude Desktop, Claude Code and
// any local MCP client. It talks to a running Clip Operator (deployed or local)
// with the workspace agent key from Settings → Agent access.
//   CLIP_API_URL  e.g. https://clip-operator-production.up.railway.app (default http://localhost:8788)
//   CLIP_API_KEY  co_agent_… (required)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, httpApi } from "./mcp";

const base = process.env.CLIP_API_URL ?? `http://localhost:${process.env.PORT ?? 8788}`;
const key = process.env.CLIP_API_KEY;
if (!key) {
  console.error("CLIP_API_KEY is required. Create one in Clip Operator → Settings → Agent access.");
  process.exit(1);
}
const server = createMcpServer(httpApi(base, key));
await server.connect(new StdioServerTransport());
// stdout is the protocol channel; log to stderr only.
console.error(`clip-operator MCP (stdio) → ${base}`);
