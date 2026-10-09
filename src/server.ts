// The Eye: dashboard + API + SSE + the Black Gate gateway endpoint.
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { store } from "./store";
import { startEye, runOnce } from "./eye";
import { blackGate } from "./blackgate";
import { askPalantir } from "./palantir";
import { agentCall, peek, setCanaryMode, resetGate } from "./gateway";
import * as ch from "./clickhouse";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json());
const pub = join(dirname(fileURLToPath(import.meta.url)), "../public");
app.use(express.static(pub));

app.get("/api/state", async (_req, res) => {
  res.json({
    servers: store.all(),
    stats: store.stats(),
    gate: blackGate.state(),
    recent: store.recent(50),
    ch: await ch.chStats(),
    chReady: ch.chReady(),
  });
});

// Server-sent events: the live feed.
app.get("/api/events", (req, res) => {
  res.set({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: "hello", ts: Date.now() })}\n\n`);
  const send = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  store.bus.on("event", send);
  req.on("close", () => store.bus.off("event", send));
});

// Detonate the canary now (the autonomous pipeline button).
app.post("/api/scan", (_req, res) => {
  runOnce().catch((e) => console.warn("scan error:", e));
  res.json({ ok: true });
});

// ── Interactive gateway (the toggle demo) ──
// An agent calls the weather MCP THROUGH Sauron; Sauron inspects + decides.
app.post("/api/agent/call", async (req, res) =>
  res.json(await agentCall(undefined, {
    runId: String(req.body?.runId ?? ""),
    call: { name: "get_forecast", args: { city: "San Francisco" } },
  })),
);

// ── Sauron as an MCP gateway: point a real agent (Claude Code) here ──
// Every tools/list and tools/call goes through the full Sauron check first, and
// the dashboard follows each one live. Allowed calls are forwarded upstream.
let claudeRuns = 0;
const claudeRunId = () => `claude-${Date.now().toString(36)}-${++claudeRuns}`;
function buildGateway() {
  const server = new Server({ name: "sauron-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const r = await agentCall(undefined, { runId: claudeRunId(), source: "claude", request: "tools/list" });
    if (r.allowed) return { tools: r.raw };
    return {
      tools: [{
        name: "sauron_quarantine_notice",
        description: `Sauron quarantined ${r.name}: ${r.summary ?? r.reasons.join("; ")} Its tools are hidden until a human reviews it. Decision record: ${r.guildUrl ?? "Guild"}`,
        inputSchema: { type: "object", properties: {} },
      }],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const r = await agentCall(undefined, { runId: claudeRunId(), source: "claude", request: `tools/call ${name}`, call: { name, args } });
    if (!r.allowed) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Blocked by Sauron. ${r.name} changed after it was approved (${r.reasons.join("; ")}). Verdict: ${r.summary ?? "unsafe"} Decision record: ${r.guildUrl ?? "Guild"}. Do not retry this server.`,
        }],
      };
    }
    return { content: [{ type: "text", text: r.result ?? "(no content)" }] };
  });
  return server;
}
app.post("/mcp", async (req, res) => {
  const server = buildGateway();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
// Stateless gateway: no server-initiated stream.
app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
app.delete("/mcp", (_req, res) => res.status(405).set("Allow", "POST").end());

// Sauron OFF: the agent talks to the MCP directly (unprotected).
app.post("/api/mcp/peek", async (_req, res) => res.json(await peek()));

// Flip the canary between honest and malicious (the live control).
app.post("/api/canary/mode", async (req, res) =>
  res.json(await setCanaryMode(req.body?.malicious === true)),
);
app.get("/api/canary/mode", async (_req, res) => {
  const r = await fetch(config.canaryUrl.replace("/mcp", "/_canary/state"))
    .then((x) => x.json())
    .catch(() => ({ mode: "unknown" }));
  res.json(r);
});

// Reset for a clean take: honest mode, forget baseline, clear the gate.
app.post("/api/gate/reset", async (_req, res) => {
  resetGate();
  await setCanaryMode(false);
  res.json({ ok: true });
});

// The catch, as SQL over ClickHouse: rows + latency + rows scanned.
app.get("/api/drift", async (_req, res) => res.json(await ch.chDriftQuery()));

// Black Gate: an agent asks "may I connect to server X?"
app.post("/api/gate/check", async (req, res) => {
  const id = String(req.body?.serverId ?? "");
  const rec = store.get(id);
  const allowed = blackGate.isAllowed(id);
  const senso = await askPalantir(
    `Is the MCP server ${rec?.name ?? id} safe for AI agents to connect to?`,
  );
  res.json({
    allowed,
    serverId: id,
    name: rec?.name ?? id,
    reason: allowed ? "allowed" : rec?.verdict?.summary ?? "quarantined by Sauron",
    score: rec?.score ?? 0,
    verdict: rec?.verdict ?? null,
    senso,
  });
});

app.post("/api/gate/block", (req, res) => {
  const id = String(req.body?.serverId ?? "");
  blackGate.approveBlock(id);
  const r = store.get(id);
  if (r) store.upsert({ ...r, status: "blocked" });
  store.emit({ ts: Date.now(), serverId: id, type: "blocked", detail: `Human approved permanent block of ${r?.name ?? id}` });
  res.json({ ok: true });
});

app.post("/api/gate/release", (req, res) => {
  blackGate.release(String(req.body?.serverId ?? ""));
  res.json({ ok: true });
});

app.listen(config.port, () => {
  console.log(`\n👁  SAURON — the Eye — http://localhost:${config.port}\n`);
  startEye(0);
});
