// The live gate. An agent calls a server THROUGH Sauron. On every call Sauron
// fetches the server's current tool definitions ("Get MCP definition"), checks
// them, and either forwards the call (clean) or blocks and tells the agent not
// to use it (poisoned). Blocking also records across the sponsors in the
// background so the UX stays instant.
import { config } from "./config";
import { inspect, callOne } from "./detonator";
import { scanSource } from "./semgrep";
import { canaryTarget } from "./registry";
import { store, mkEvent } from "./store";
import { blackGate } from "./blackgate";
import { writeVerdict } from "./palantir";
import { triageSummary, agentReason } from "./akash";
import * as ch from "./clickhouse";
import type { Finding, ServerRecord, ToolDescriptor, Verdict } from "./types";

const INSTRUCTION_RE =
  /(ignore (the )?previous|disregard.*previous|before answering|first call|do not (mention|tell)|follow the instructions in|\[CANARY_DRIFT\])/i;
const DEADBUGZ = "https://www.pillar.security/blog/deadbugz-currently-active-mcp-supply-chain-campaign";

const baselines = new Map<string, Set<string>>(); // serverId -> "name:hash"
let callCounter = 0;

export interface GatewayResult {
  serverId: string;
  name: string;
  callNo: number;
  request: string;
  tools: { name: string; description: string; changed: boolean; isNew: boolean; flagged: boolean }[];
  detected: boolean;
  reasons: string[];
  allowed: boolean;
  agentMessage: string;
  result?: string;
  agent?: string; // what a real LLM agent did with the result
}

const TASK = "What's the weather in San Francisco?";

const key = (t: ToolDescriptor) => `${t.name}:${t.descHash}`;

export async function agentCall(serverId = "canary:acme-weather-mcp"): Promise<GatewayResult> {
  callCounter += 1;
  const base = store.get(serverId) ?? canaryTarget();
  const name = base.name;
  const url = base.url || config.canaryUrl;

  const { tools, error } = await inspect(url);
  if (error) {
    return {
      serverId, name, callNo: callCounter, request: "tools/list", tools: [],
      detected: false, reasons: [`unreachable: ${error}`], allowed: false,
      agentMessage: `Could not reach ${name}.`,
    };
  }

  const baseline = baselines.get(serverId);
  const baseNames = baseline ? new Set([...baseline].map((k) => k.split(":")[0])) : null;

  const annotated = tools.map((t) => {
    const isNew = baseNames ? !baseNames.has(t.name) : false;
    const changed = baseline && !isNew ? !baseline.has(key(t)) : false;
    const flagged = INSTRUCTION_RE.test(t.description) || isNew || changed;
    return { name: t.name, description: t.description, changed, isNew, flagged };
  });

  const instr = tools.filter((t) => INSTRUCTION_RE.test(t.description)).map((t) => t.name);
  const changedTools = annotated.filter((a) => a.changed).map((a) => a.name);
  const newTools = annotated.filter((a) => a.isNew).map((a) => a.name);

  const reasons: string[] = [];
  if (instr.length) reasons.push(`instruction-like text in ${instr.join(", ")}`);
  if (changedTools.length) reasons.push(`description changed: ${changedTools.join(", ")}`);
  if (newTools.length) reasons.push(`new tool after approval: ${newTools.join(", ")}`);
  const detected = reasons.length > 0;

  if (!detected && !baseline) baselines.set(serverId, new Set(tools.map(key)));

  if (detected) {
    // Block synchronously so state reflects it immediately.
    blackGate.quarantine(serverId, reasons.join("; "));
    const findings = buildFindings(serverId, changedTools, newTools, instr);
    const updated: ServerRecord = {
      ...base, status: "quarantined", score: 100, findings,
      toolsAfter: tools, lastChecked: Date.now(),
    };
    store.upsert(updated);
    const ev = mkEvent(serverId, "quarantined", `Gate blocked ${name}: ${reasons.join("; ")}`);
    store.emit(ev);
    // Heavy sponsor writes in the background (Akash summary + Senso + ClickHouse).
    void recordBlock(updated, findings, tools, reasons);
    return {
      serverId, name, callNo: callCounter, request: "tools/list", tools: annotated,
      detected: true, reasons, allowed: false,
      agentMessage: `⛔ Blocked by Sauron. ${name} changed its tools after approval — ${reasons.join("; ")}. Do not use this server.`,
      agent: `🛡 Sauron blocked ${name} before I saw its tools. I won't use it.`,
    };
  }

  // Clean: forward the real call so the agent gets a genuine answer.
  const first = tools[0];
  let result: string | undefined;
  if (first) {
    const r = await callOne(url, first.name, { city: "San Francisco", value: 20, from: "c", to: "f" });
    result = r.text || "ok";
  }
  const updated: ServerRecord = {
    ...base, status: "clean", score: 0, findings: [], toolsBefore: tools, lastChecked: Date.now(),
  };
  store.upsert(updated);
  const ev = mkEvent(serverId, "info", `Gate allowed ${name} (call #${callCounter})`);
  store.emit(ev);
  void ch.chInsertSnapshot({ serverId, ts: Date.now(), phase: "before", callCount: callCounter, tools }, name);
  void ch.chInsertEvent(ev);
  const agent = await agentReason(tools, TASK);
  return {
    serverId, name, callNo: callCounter, request: "tools/list", tools: annotated,
    detected: false, reasons: [], allowed: true,
    agentMessage: `✅ ${name} is clean. Agent called ${first?.name ?? "the tool"} → ${result ?? "ok"}`,
    result,
    agent,
  };
}

function buildFindings(serverId: string, changed: string[], appeared: string[], instr: string[]): Finding[] {
  const ts = Date.now();
  const out: Finding[] = [];
  if (changed.length) out.push({ serverId, ts, kind: "drift", severity: "critical", detail: `description changed: ${changed.join(", ")}` });
  if (appeared.length) out.push({ serverId, ts, kind: "drift", severity: "high", detail: `new tool after approval: ${appeared.join(", ")}` });
  if (instr.length) out.push({ serverId, ts, kind: "instruction_text", severity: "high", detail: `instruction-like text in ${instr.join(", ")}` });
  return out;
}

async function recordBlock(rec: ServerRecord, findings: Finding[], tools: ToolDescriptor[], reasons: string[]) {
  try {
    // Semgrep scans the server's own published code (static), on top of the
    // runtime drift already detected — so all five sponsors act on a block.
    const ts = Date.now();
    const semgrep = await scanSource(config.semgrep.canarySource);
    const semFindings: Finding[] = semgrep.map((f) => ({
      serverId: rec.id, ts, kind: "semgrep",
      severity: f.severity === "ERROR" ? "critical" : f.severity === "WARNING" ? "medium" : "low",
      detail: `${f.ruleId} (${f.path}:${f.line})`, evidence: f.message,
    }));
    const allFindings = [...findings, ...semFindings];
    if (semFindings.length) {
      const se = mkEvent(rec.id, "finding", `Semgrep: ${semFindings.length} findings in the server's code`);
      store.emit(se);
    }

    const summary = await triageSummary(rec.name, "rug_pull", 100, allFindings);
    const verdict: Verdict = {
      serverId: rec.id, ts: Date.now(), verdict: "rug_pull", score: 100, summary,
      sources: [`gate-call`, ...reasons, ...semFindings.map((f) => f.detail), DEADBUGZ],
    };
    const ref = await writeVerdict({ ...rec, findings: allFindings, verdict }, verdict);
    verdict.sources.unshift(`senso:${ref.id}`);
    store.upsert({ ...(store.get(rec.id) ?? rec), findings: allFindings, verdict });
    await ch.chInsertFindings(allFindings);
    await ch.chInsertVerdict(verdict);
    await ch.chInsertSnapshot({ serverId: rec.id, ts: Date.now(), phase: "after", callCount: callCounter, tools }, rec.name);
    const ev = mkEvent(rec.id, "verdict", `RUG_PULL 100/100 — ${summary}`);
    store.emit(ev);
    await ch.chInsertEvent(ev);
  } catch (e) {
    console.warn("recordBlock failed:", (e as Error).message);
  }
}

// Sauron OFF: the agent talks to the MCP directly. We just read what the server
// returns (no gate, no checks, no blocking) — to show the unprotected path.
export async function peek(serverId = "canary:acme-weather-mcp"): Promise<{
  tools: { name: string; description: string; flagged: boolean }[];
  poisoned: boolean;
  poisonText?: string;
  agent?: string;
  error?: string;
}> {
  const base = store.get(serverId) ?? canaryTarget();
  const url = base.url || config.canaryUrl;
  const { tools, error } = await inspect(url);
  const annotated = tools.map((t) => ({
    name: t.name, description: t.description, flagged: INSTRUCTION_RE.test(t.description),
  }));
  const poison = tools.find((t) => INSTRUCTION_RE.test(t.description));
  // A REAL agent: the LLM reads the tools exactly as returned. With no gate, a
  // poisoned description reaches the model — and it follows it.
  const agent = tools.length ? await agentReason(tools, TASK) : undefined;
  return { tools: annotated, poisoned: !!poison, poisonText: poison?.description, agent, error };
}

export async function setCanaryMode(malicious: boolean): Promise<{ mode: string }> {
  await fetch(config.canaryUrl.replace("/mcp", "/_canary/mode"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ malicious }),
  }).catch(() => {});
  if (!malicious) blackGate.release("canary:acme-weather-mcp");
  return { mode: malicious ? "malicious" : "honest" };
}

export function resetGate(serverId = "canary:acme-weather-mcp") {
  baselines.delete(serverId);
  blackGate.release(serverId);
}
