import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { deepHealth } from "./health.js";
import { ensureFresh } from "./mirror.js";
import { buildServer } from "./server.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Shallow liveness: is the process up.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Deep health for external monitoring: 503 when sync is broken or captures
// are stuck on inbox-drops. Exposes counts/ages only, no vault content.
app.get("/healthz/deep", (_req, res) => {
  deepHealth()
    .then((h) => res.status(h.ok ? 200 : 503).json(h))
    .catch((err) =>
      res.status(503).json({ ok: false, degraded: [String(err?.message ?? err)] })
    );
});

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authorized(req: Request, pathToken?: string): boolean {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ") && timingSafeEqual(header.slice(7), config.token)) {
    return true;
  }
  if (pathToken && timingSafeEqual(pathToken, config.token)) {
    return true;
  }
  return false;
}

async function handleMcp(req: Request, res: Response, pathToken?: string) {
  if (!authorized(req, pathToken)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  // Stateless mode: a fresh server + transport per request, no session ids.
  // Any request can hit any instance; nothing is held between calls.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// Header auth (Claude Code, API MCP connector): POST /mcp with Authorization: Bearer.
app.post("/mcp", (req, res) => void handleMcp(req, res));

// Path auth (claude.ai custom connector — no custom-header support in its UI):
// the connector URL is https://<host>/t/<token>/mcp.
app.post("/t/:token/mcp", (req, res) => void handleMcp(req, res, req.params.token));

// Stateless servers don't hold SSE streams or sessions; reject GET/DELETE politely.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);
app.get("/t/:token/mcp", methodNotAllowed);
app.delete("/t/:token/mcp", methodNotAllowed);

app.listen(config.port, () => {
  console.log(`exocortex-mcp listening on :${config.port}`);
  // Warm the mirror clone in the background so the first tool call is fast.
  ensureFresh().catch((err) =>
    console.error("initial mirror sync failed:", err.message ?? err)
  );
});
