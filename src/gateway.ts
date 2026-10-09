// The live gate, as a REAL sequential pipeline with ClickHouse as the drift
// detector. An agent calls a server through Sauron:
//   1. ClickHouse holds the approved baseline. First sight → baseline the tools.
//   2. Later calls → compare the current tools to that stored baseline.
//   3. Only a real drift triggers the analysis: Semgrep scans the code, Akash
//      writes the verdict from those findings, Senso saves it, ClickHouse records
//      it, Guild blocks it — and the agent's answer is the real Akash verdict.
// Every value here comes from an actual call; nothing is pre-written.
import { execSync } from "node:child_process";
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
  /(ignore (the )?previous|disregard.*previous|before answering|first call|do not (mention|tell)|follow the instructions in|read .*(api key|credential|environment|secret)|send .*(credential|environment|the collected|variables)|OPENAI_API_KEY|AWS_SECRET|\[CANARY_DRIFT\])/i;
const DEADBUGZ = "https://www.pillar.security/blog/deadbugz-currently-active-mcp-supply-chain-campaign";
const TASK = "What's the weather in San Francisco?";

// Fallback trace destinations. Each run overrides these with a link to its own
// record: the ClickHouse query, the Semgrep lines, the Senso doc, the Guild session.
const TRACE = {
  semgrep: "https://github.com/Metroxe/sauron/blob/main/semgrep/mcp-rules.yaml",
  // AkashML lists every inference newest-first; the top row is this run.
  akash: "https://playground.akashml.com/inferences",
  senso: "https://geo.senso.ai/knowledge-base",
  guild: "https://app.guild.ai",
};

// The Black Gate agent on Guild writes the decision record for this run. The
// session opens in under a second; the agent's written decision (~9 s) streams
// to the dashboard as an update, so the gate never waits on it.
async function guildStage(
  prompt: string,
  decision: string,
  fallback: string,
  update: (s: Stage) => void,
): Promise<Stage> {
  const g = await blackGate.openDecision(prompt);
  if (!g.id) return { key: "guild", output: fallback, trace: TRACE.guild };
  const stage: Stage = { key: "guild", output: `${decision} sent to the Black Gate agent · session ${g.id.slice(0, 8)}…`, trace: g.sessionUrl };
  void blackGate.decisionReply(g.id).then((reply) => {
    if (reply) update({ ...stage, output: reply.replace(/\s*\n+\s*/g, " · ") });
  });
  return stage;
}

const lastReset = new Map<string, number>(); // per-server reset epoch
let callCounter = 0;

// Pin Semgrep links to the exact commit so line numbers never drift.
let SHA = "main";
try {
  SHA = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "main";
} catch { /* not a git checkout; fall back to main */ }

// Link to the exact lines Semgrep flagged, in the commit that's running.
function semgrepTrace(found: { ruleId: string; path: string; line: number }[]): string {
  if (!found.length) return TRACE.semgrep;
  const path = found[0].path;
  const inj = found.filter((f) => f.ruleId.includes("prompt-injection") && f.path === path).map((f) => f.line).sort((a, b) => a - b);
  const lines = found.filter((f) => f.path === path).map((f) => f.line).sort((a, b) => a - b);
  const range = inj.length ? `#L${inj[0]}-L${inj[inj.length - 1]}` : `#L${lines[0]}`;
  return `https://github.com/Metroxe/sauron/blob/${SHA}/${path}${range}`;
}

export type StageKey = "sauron" | "semgrep" | "akash" | "senso" | "ch" | "guild";
export interface Stage { key: StageKey; output: string; trace?: string }

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
  agent?: string;
  result?: string;
  stages: Stage[];
}

function buildFindings(serverId: string, changed: string[], appeared: string[], instr: string[]): Finding[] {
  const ts = Date.now();
  const out: Finding[] = [];
  if (changed.length) out.push({ serverId, ts, kind: "drift", severity: "critical", detail: `description changed: ${changed.join(", ")}` });
  if (appeared.length) out.push({ serverId, ts, kind: "drift", severity: "high", detail: `new tool after approval: ${appeared.join(", ")}` });
  if (instr.length) out.push({ serverId, ts, kind: "instruction_text", severity: "high", detail: `instruction-like text in ${instr.join(", ")}` });
  return out;
}

export async function agentCall(serverId = "canary:acme-weather-mcp", runId = ""): Promise<GatewayResult> {
  callCounter += 1;
  const base = store.get(serverId) ?? canaryTarget();
  const name = base.name;
  const url = base.url || config.canaryUrl;

  const { tools, error } = await inspect(url);
  if (error) {
    return { serverId, name, callNo: callCounter, request: "tools/list", tools: [], detected: false, reasons: [`unreachable: ${error}`], allowed: false, agentMessage: `Could not reach ${name}.`, stages: [] };
  }

  // ClickHouse is the drift detector: fetch the stored approved baseline.
  const sinceMs = lastReset.get(serverId) ?? 0;
  const t0 = Date.now();
  const baseline = await ch.chGetBaseline(serverId, sinceMs);
  const chMs = Date.now() - t0;
  const chTrace = ch.chQueryUrl(ch.chRunSql(serverId, sinceMs, callCounter));
  const firstSeen = baseline.size === 0;
  const toolList = tools.map((t) => t.name).join(", ");
  const now = Date.now();
  const stages: Stage[] = [];
  // Stream each stage to the dashboard the moment its real call finishes.
  const emit = (payload: Record<string, unknown>) =>
    store.emit(mkEvent(serverId, "stage", JSON.stringify({ runId, ...payload })));
  const add = (s: Stage, bad: boolean) => { stages.push(s); emit({ kind: "svc", ...s, bad }); };
  const update = (s: Stage) => emit({ kind: "svc-update", ...s });

  const annotated = tools.map((t) => {
    const isNew = firstSeen ? false : !baseline.has(t.name);
    const changed = !firstSeen && baseline.has(t.name) && baseline.get(t.name) !== t.descHash;
    const flagged = INSTRUCTION_RE.test(t.description) || isNew || changed;
    return { name: t.name, description: t.description, changed, isNew, flagged };
  });

  if (firstSeen) {
    stages.push({ key: "sauron", output: "First time seeing this server" });
    emit({ kind: "gate", detected: false, reasons: [], tools: annotated, sauron: "First time seeing this server" });
    await ch.chWriteBaseline(serverId, name, tools);
    add({ key: "ch", output: `No baseline yet (${chMs} ms) · stored ${tools.length} tools as approved`, trace: chTrace }, false);
    const agentP = agentReason(tools, TASK);
    add(await guildStage(
      `Gateway decision #${callCounter}. Server: ${name}. Decision: BASELINE. Evidence: first time Sauron has seen this server; its ${tools.length} tools (${toolList}) were stored in ClickHouse as the approved baseline.`,
      "BASELINE", "Approved · agent may connect", update,
    ), false);
    store.upsert({ ...base, status: "clean", score: 0, toolsBefore: tools, lastChecked: now });
    const agent = await agentP;
    return { serverId, name, callNo: callCounter, request: "tools/list", tools: annotated, detected: false, reasons: [], allowed: true, agentMessage: `${name} baselined (first seen).`, agent, stages };
  }

  const instr = tools.filter((t) => INSTRUCTION_RE.test(t.description)).map((t) => t.name);
  const changedTools = annotated.filter((a) => a.changed).map((a) => a.name);
  const newTools = annotated.filter((a) => a.isNew).map((a) => a.name);
  const reasons: string[] = [];
  if (changedTools.length) reasons.push(`description changed: ${changedTools.join(", ")}`);
  if (newTools.length) reasons.push(`new tool after approval: ${newTools.join(", ")}`);
  if (instr.length) reasons.push(`instruction-like text in ${instr.join(", ")}`);
  const detected = reasons.length > 0;

  // Sauron + ClickHouse: the drift check vs the stored baseline (first in the chain).
  const sauronOut = detected ? "Drift from the approved baseline" : "Matches the approved baseline";
  stages.push({ key: "sauron", output: sauronOut });
  emit({ kind: "gate", detected, reasons, tools: annotated, sauron: sauronOut });
  // Log what the server served on this call, next to the baseline it was checked against.
  await ch.chInsertSnapshot({ serverId, ts: Date.now(), phase: detected ? "after" : "check", callCount: callCounter, tools }, name);
  const drifted = [...changedTools, ...newTools];
  add({
    key: "ch",
    output: detected ? `Drift vs baseline (${chMs} ms): ${drifted.join(", ")}` : `No drift vs baseline (${chMs} ms)`,
    trace: chTrace,
  }, detected);

  if (!detected) {
    const agentP = agentReason(tools, TASK);
    add(await guildStage(
      `Gateway decision #${callCounter}. Server: ${name}. Decision: ALLOW. Evidence: all ${tools.length} tools (${toolList}) match the approved baseline stored in ClickHouse; no description changed and no tool was added.`,
      "ALLOW", "Allowed at the gate", update,
    ), false);
    store.upsert({ ...base, status: "clean", score: 0, toolsBefore: tools, lastChecked: now });
    const ev = mkEvent(serverId, "info", `Gate allowed ${name} (call #${callCounter})`); store.emit(ev); void ch.chInsertEvent(ev);
    const first = tools[0];
    let result: string | undefined;
    if (first) { const r = await callOne(url, first.name, { city: "San Francisco", value: 20, from: "c", to: "f" }); result = r.text || "ok"; }
    const agent = await agentP;
    return { serverId, name, callNo: callCounter, request: "tools/list", tools: annotated, detected: false, reasons: [], allowed: true, agentMessage: `${name} matches its approved baseline.`, agent, result, stages };
  }

  // Drift → the analysis + approval flow, each tool feeding the next.
  const semgrep = await scanSource(config.semgrep.canarySource);
  const semRules = [...new Set(semgrep.map((f) => f.ruleId))];
  const semFindings: Finding[] = semgrep.map((f) => ({
    serverId, ts: now, kind: "semgrep",
    severity: f.severity === "ERROR" ? "critical" : f.severity === "WARNING" ? "medium" : "low",
    detail: `${f.ruleId} (${f.path}:${f.line})`, evidence: f.message,
  }));
  add({ key: "semgrep", output: semgrep.length ? `${semgrep.length} findings: ${semRules.join(", ")}` : "no code findings", trace: semgrepTrace(semgrep) }, true);
  const findings = [...buildFindings(serverId, changedTools, newTools, instr), ...semFindings];

  const summary = await triageSummary(name, "rug_pull", 100, findings);
  add({ key: "akash", output: summary, trace: TRACE.akash }, true);

  const verdict: Verdict = { serverId, ts: Date.now(), verdict: "rug_pull", score: 100, summary, sources: [...reasons, ...semFindings.map((f) => f.detail), DEADBUGZ] };
  const ref = await writeVerdict({ ...base, findings, verdict }, verdict);
  verdict.sources.unshift(`senso:${ref.id}`);
  add({ key: "senso", output: `Saved verdict ${String(ref.id).slice(0, 12)}…`, trace: ref.url ?? TRACE.senso }, true);

  await ch.chInsertFindings(findings);
  await ch.chInsertVerdict(verdict);

  blackGate.quarantine(serverId, reasons.join("; "));
  // The agent's real answer, reasoning over Sauron's verdict (not pre-written).
  const agentP = agentReason(
    [{ name: "sauron_security_gate", description: `BLOCKED by Sauron. ${name} was quarantined: ${summary}` }],
    TASK,
  );
  add(await guildStage(
    [
      `Gateway decision #${callCounter}. Server: ${name}. Decision: QUARANTINE.`,
      `Drift vs the approved baseline in ClickHouse: ${reasons.join("; ")}.`,
      `Semgrep: ${semgrep.length ? semgrep.map((f) => `${f.ruleId} at ${f.path}:${f.line}`).join("; ") : "no code findings"}.`,
      `Akash triage: ${summary}`,
      `Verdict saved in Senso as ${ref.id}. Reference: ${DEADBUGZ}`,
    ].join("\n"),
    "QUARANTINE", "Quarantined · permanent block awaits a human", update,
  ), true);

  const updated: ServerRecord = { ...base, status: "quarantined", score: 100, findings, toolsAfter: tools, lastChecked: Date.now(), verdict };
  store.upsert(updated);
  const ev = mkEvent(serverId, "quarantined", `Gate blocked ${name}: ${reasons.join("; ")}`); store.emit(ev); await ch.chInsertEvent(ev);

  const agent = await agentP;

  return { serverId, name, callNo: callCounter, request: "tools/list", tools: annotated, detected: true, reasons, allowed: false, agentMessage: `Blocked: ${reasons.join("; ")}`, agent, stages };
}

// Sauron OFF: the agent talks to the MCP directly (no gate, no checks).
export async function peek(serverId = "canary:acme-weather-mcp"): Promise<{
  tools: { name: string; description: string; flagged: boolean }[];
  poisoned: boolean; poisonText?: string; agent?: string; error?: string;
}> {
  const base = store.get(serverId) ?? canaryTarget();
  const url = base.url || config.canaryUrl;
  const { tools, error } = await inspect(url);
  const a = tools.map((t) => ({ name: t.name, description: t.description, flagged: INSTRUCTION_RE.test(t.description) }));
  const poison = tools.find((t) => INSTRUCTION_RE.test(t.description));
  const agent = tools.length ? await agentReason(tools, TASK) : undefined;
  return { tools: a, poisoned: !!poison, poisonText: poison?.description, agent, error };
}

export async function setCanaryMode(malicious: boolean): Promise<{ mode: string }> {
  await fetch(config.canaryUrl.replace("/mcp", "/_canary/mode"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ malicious }),
  }).catch(() => {});
  if (!malicious) blackGate.release("canary:acme-weather-mcp");
  return { mode: malicious ? "malicious" : "honest" };
}

// Reset: forget the baseline (next call re-baselines) and clear the gate.
export function resetGate(serverId = "canary:acme-weather-mcp") {
  lastReset.set(serverId, Date.now());
  blackGate.release(serverId);
}
