import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { deepHealth } from "./health.js";
import { ensureFresh } from "./mirror.js";
import { redact } from "./redact.js";
import { buildServer, type Role } from "./server.js";

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
      res.status(503).json({ ok: false, degraded: [redact(String(err?.message ?? err))] })
    );
});

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

type AuthMethod = "bearer" | "path";

interface Auth {
  role: Role;
  method: AuthMethod;
}

/** Match a presented token against the owner secret, then the guest secret. */
function matchToken(presented: string): Role | null {
  if (timingSafeEqual(presented, config.token)) return "owner";
  if (config.guestToken && timingSafeEqual(presented, config.guestToken)) {
    return "guest";
  }
  return null;
}

function authorized(req: Request, pathToken?: string): Auth | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const role = matchToken(header.slice(7));
    if (role) return { role, method: "bearer" };
  }
  if (pathToken) {
    const role = matchToken(pathToken);
    if (role) return { role, method: "path" };
  }
  return null;
}

async function handleMcp(req: Request, res: Response, pathToken?: string) {
  const auth = authorized(req, pathToken);
  if (!auth) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  // Stateless mode: a fresh server + transport per request, no session ids.
  // Any request can hit any instance; nothing is held between calls.
  // Client identity: the MCP initialize handshake's clientInfo never reaches a
  // stateless tool call, but the auth method that actually authorized this
  // request distinguishes the surface (path auth is only used by the claude.ai
  // connector) and the User-Agent fills in the rest. Stamped into capture
  // frontmatter as `captured_via`.
  const ua = req.get("user-agent");
  const clientHint =
    (auth.method === "path" ? "claude.ai connector" : "bearer-auth client") +
    (auth.role === "guest" ? ", guest tier" : "") +
    (ua ? `, ${ua}` : "");
  const server = buildServer(auth.role, clientHint);
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
    console.error("initial mirror sync failed:", redact(String(err.message ?? err)))
  );
});
