import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WellKnownService } from "./discovery/well-known.js";
import { WELL_KNOWN_PATH, WELL_KNOWN_CACHE_TTL_SECONDS } from "./discovery/well-known.js";

// HTTP transport — Fase A (stdio → StreamableHTTP).
// Two surfaces only:
//   GET  /.well-known/seller-mcp-capabilities  — the E-12 trust anchor at its CANONICAL
//        route (e12-signoff §5 RATIFIED). Public by design; Cache-Control aligned with
//        the ratified buyer-side TTL (§6, ≤15 min).
//   POST/GET/DELETE /mcp — StreamableHTTP MCP endpoint (session-per-buyer-agent).
// Anything else → 404 with an empty body (no surface disclosure).
//
// Default bind is 127.0.0.1: serving EXTERNALLY (0.0.0.0 / public host) remains an
// infra act gated by blockers #8/#10 — the operator must set MCP_HTTP_HOST explicitly.

export const MCP_PATH = "/mcp";

export interface HttpOptions {
  host: string;
  port: number;
}

export function httpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const host = env.MCP_HTTP_HOST ?? "127.0.0.1";
  const port = env.MCP_HTTP_PORT ? Number(env.MCP_HTTP_PORT) : 3900;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`[http] Invalid MCP_HTTP_PORT: ${env.MCP_HTTP_PORT}`);
  }
  return { host, port };
}

interface HttpDeps {
  // One McpServer per MCP session — buildServer is cheap and sessions stay isolated.
  makeServer: () => McpServer;
  wellKnown: WellKnownService;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

export async function startHttpServer(deps: HttpDeps, opts: HttpOptions): Promise<Server> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // E-12 trust anchor at its canonical route — public, no auth, no audit event
      // (the 16 ratified event classes contain no discovery-read class; set is closed).
      if (url.pathname === WELL_KNOWN_PATH && req.method === "GET") {
        const signedDoc = await deps.wellKnown.sign();
        res.writeHead(200, {
          "Content-Type": "application/jose",
          "Cache-Control": `public, max-age=${WELL_KNOWN_CACHE_TTL_SECONDS}`,
        });
        res.end(signedDoc);
        return;
      }

      if (url.pathname !== MCP_PATH) {
        res.writeHead(404).end();
        return;
      }

      let body: unknown;
      if (req.method === "POST") {
        try {
          body = await readJsonBody(req);
        } catch {
          jsonRpcError(res, 400, -32700, "Parse error");
          return;
        }
      }

      const sessionId = req.headers["mcp-session-id"];
      let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

      if (!transport) {
        // Only an initialize request may open a new session.
        if (req.method !== "POST" || sessionId !== undefined || !isInitializeRequest(body)) {
          jsonRpcError(res, 400, -32000, "Bad Request: no valid session");
          return;
        }
        const newTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id): void => {
            sessions.set(id, newTransport);
          },
        });
        newTransport.onclose = () => {
          if (newTransport.sessionId) sessions.delete(newTransport.sessionId);
        };
        await deps.makeServer().connect(newTransport);
        transport = newTransport;
      }

      await transport.handleRequest(req, res, body);
    } catch (err) {
      // Never leak internals over the wire (soap-fault-redaction §2).
      process.stderr.write(`[http] request error: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal error");
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, resolve);
  });

  return httpServer;
}
