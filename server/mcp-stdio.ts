// Studio Operator MCP server over stdio — for Claude Desktop, Claude Code and
// any local MCP client. Talks to a running Studio Operator API
// (npm run dev / npm start). Set STUDIO_API_URL if it isn't on :8787.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, httpApi } from "./mcp";

const base = process.env.STUDIO_API_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const server = createMcpServer(httpApi(base));
await server.connect(new StdioServerTransport());
// stdout is the protocol channel; log to stderr only.
console.error(`studio-operator MCP (stdio) → ${base}`);
