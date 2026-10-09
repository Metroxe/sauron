// The live gate, as a REAL sequential pipeline with ClickHouse as the drift
// detector. An agent calls a server through Sauron:
//   1. ClickHouse holds the approved baseline. First sight → baseline the tools.
//   2. Later calls → compare the current tools to that stored baseline.
//   3. Only a real drift triggers the analysis: Semgrep scans the code, Akash
//      writes the verdict from those findings, Senso saves it, ClickHouse records
//      it, Guild blocks it — and the agent's answer is the real Akash verdict.
// Every value here comes from an actual call; nothing is pre-written.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { config } from "./config";
import { inspect, callOne } from "./detonator";
import { scanManifest } from "./semgrep";
import { canaryTarget } from "./registry";
import { store, mkEvent } from "./store";
import { blackGate } from "./blackgate";
import { writeVerdict } from "./palantir";
import { triageSummary, agentReason } from "./akash";
import * as ch from "./clickhouse";
import type { Finding, Verdict } from "./types";

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

// Link to the Semgrep rule that fired, in the commit that's running. With no
// findings, link to the rule file that ran.
const RULES_PATH = "semgrep/mcp-rules.yaml";
function ruleTrace(ruleIds: string[]): string {
  const base = `https://github.com/Metroxe/sauron/blob/${SHA}/${RULES_PATH}`;
  if (!ruleIds.length) return base;
  try {
    const lines = readFileSync(RULES_PATH, "utf8").split("\n");
    const start = lines.findIndex((l) => l.includes(`id: ${ruleIds[0]}`));
    if (start < 0) return base;
    let end = lines.findIndex((l, i) => i > start && /^\s*- id:/.test(l));
    if (end < 0) end = lines.length;
    while (end - 1 > start && !lines[end - 1].trim()) end--;
    return `${base}#L${start + 1}-L${end}`;
  } catch {
    return base;
  }
}

export type StageKey = "sauron" | "semgrep" | "akash" | "senso" | "ch" | "guild";
export type Tone = "ok" | "warn" | "bad";
export interface Stage { key: StageKey; output: string; trace?: string; tone?: Tone }

export interface GatewayResult {
  serverId: string;
  name: string;
  callNo: number;
  request: string;
  tools: { name: string; description: string; changed: boolean; isNew: boolean; flagged: boolean }[];
  raw: any[]; // the server's full tool list, for proxying to a real agent
  review: boolean; // first sight or drift: the full flow ran
  detected: boolean; // the review found it unsafe
  reasons: string[];
  allowed: boolean;
  agentMessage: string;
  agent?: string;
  result?: string;
  summary?: string;
  guildUrl?: string;
  stages: Stage[];
}

export interface CallOpts {
  runId?: string;
  source?: "dashboard" | "claude";
  request?: string; // what the agent asked for, e.g. "tools/call get_forecast"
  call?: { name: string; args: Record<string, unknown> }; // forwarded if allowed
}

export async function agentCall(serverId = "canary:acme-weather-mcp", opts: CallOpts = {}): Promise<GatewayResult> {
  const runId = opts.runId ?? "";
  const source = opts.source ?? "dashboard";
  const request = opts.request ?? "tools/list";
  const callNo = ++callCounter;
  const base = store.get(serverId) ?? canaryTarget();
  const name = base.name;
  const url = base.url || config.canaryUrl;
  const stages: Stage[] = [];

  // Stream each stage to the dashboard the moment its real call finishes.
  const emit = (payload: Record<string, unknown>) =>
    store.emit(mkEvent(serverId, "stage", JSON.stringify({ runId, source, request, ...payload })));
  const add = (s: Stage, tone: Tone) => { s.tone = tone; stages.push(s); emit({ kind: "svc", ...s, bad: tone === "bad" }); };
  const update = (s: Stage) => emit({ kind: "svc-update", ...s });
  const finish = (r: Omit<GatewayResult, "serverId" | "name" | "callNo" | "request" | "stages">): GatewayResult => {
    const out = { serverId, name, callNo, request, stages, ...r };
    emit({ kind: "done", allowed: out.allowed, review: out.review, detected: out.detected, agent: out.agent, agentMessage: out.agentMessage, result: out.result });
    return out;
  };

  const { tools, raw, error } = await inspect(url);
  if (error) {
    emit({ kind: "gate", review: false, firstSeen: false, reasons: [`unreachable: ${error}`], tools: [], sauron: `Could not reach ${name}` });
    return finish({ tools: [], raw: [], review: false, detected: false, reasons: [`unreachable: ${error}`], allowed: false, agentMessage: `Could not reach ${name}.` });
  }

  // ClickHouse is the drift detector: fetch the stored approved baseline.
  const sinceMs = lastReset.get(serverId) ?? 0;
  const t0 = Date.now();
  const baseline = await ch.chGetBaseline(serverId, sinceMs);
  const chMs = Date.now() - t0;
  const chTrace = ch.chQueryUrl(ch.chRunSql(serverId, sinceMs, callNo));
  const firstSeen = baseline.size === 0;
  const toolList = tools.map((t) => t.name).join(", ");
  const now = Date.now();

  const annotated = tools.map((t) => {
    const isNew = !firstSeen && !baseline.has(t.name);
    const changed = !firstSeen && baseline.has(t.name) && baseline.get(t.name) !== t.descHash;
    return { name: t.name, description: t.description, changed, isNew, flagged: INSTRUCTION_RE.test(t.description) || isNew || changed };
  });
  const changedTools = annotated.filter((a) => a.changed).map((a) => a.name);
  const newTools = annotated.filter((a) => a.isNew).map((a) => a.name);
  const driftReasons: string[] = [];
  if (changedTools.length) driftReasons.push(`description changed: ${changedTools.join(", ")}`);
  if (newTools.length) driftReasons.push(`new tool after approval: ${newTools.join(", ")}`);
  // Anything new to us (first sight) or changed since approval gets the full review.
  const review = firstSeen || driftReasons.length > 0;

  const sauronOut = firstSeen ? "New server · full review" : review ? "Drift from the approved baseline · full review" : "Matches the approved baseline";
  stages.push({ key: "sauron", output: sauronOut });
  emit({ kind: "gate", review, firstSeen, reasons: firstSeen ? ["first time Sauron has seen this server"] : driftReasons, tools: annotated, sauron: sauronOut });

  // Log what the server served on this call, next to the baseline it was checked against.
  await ch.chInsertSnapshot({ serverId, ts: Date.now(), phase: review && !firstSeen ? "after" : "check", callCount: callNo, tools }, name);

  // The proxied tool call, made only once the gate allows it.
  const forward = async () => {
    if (!opts.call) return undefined;
    const r = await callOne(url, opts.call.name, opts.call.args);
    return r.error ? `error: ${r.error}` : r.text;
  };
  const isClaude = source === "claude";

  if (!review) {
    add({ key: "ch", output: `No drift vs approved baseline (${chMs} ms)`, trace: chTrace }, "ok");
    const agentP = isClaude ? Promise.resolve(undefined) : agentReason(tools, TASK);
    const g = await guildStage(
      `Gateway decision #${callNo}. Server: ${name}. Request: ${request}. Decision: ALLOW. Evidence: all ${tools.length} tools (${toolList}) match the approved baseline stored in ClickHouse; no description changed and no tool was added.`,
      "ALLOW", "Allowed at the gate", update,
    );
    add(g, "ok");
    store.upsert({ ...base, status: "clean", score: 0, toolsBefore: tools, lastChecked: now });
    const ev = mkEvent(serverId, "info", `Gate allowed ${name} (call #${callNo})`); store.emit(ev); void ch.chInsertEvent(ev);
    const result = await forward();
    const agent = await agentP;
    return finish({ tools: annotated, raw, review: false, detected: false, reasons: [], allowed: true, agentMessage: `${name} matches its approved baseline.`, agent, result, guildUrl: g.trace });
  }

  add({
    key: "ch",
    output: firstSeen
      ? `No baseline yet (${chMs} ms) · new server, sending to review`
      : `Drift vs baseline (${chMs} ms): ${[...changedTools, ...newTools].join(", ")}`,
    trace: chTrace,
  }, "warn");

  // Semgrep: our MCP rules over the exact tool definitions served on this call.
  const scan = await scanManifest(name, callNo, tools);
  const sem = scan.findings;
  const semRules = [...new Set(sem.map((f) => f.ruleId))];
  const semTools = [...new Set(sem.map((f) => f.tool).filter(Boolean))] as string[];
  add({
    key: "semgrep",
    output: sem.length
      ? `${sem.length} finding${sem.length > 1 ? "s" : ""}: ${semRules.join(", ")} in ${semTools.join(", ")}`
      : `0 findings in ${tools.length} served tool definitions`,
    trace: ruleTrace(semRules),
  }, sem.length ? "bad" : "ok");

  const instr = tools.filter((t) => INSTRUCTION_RE.test(t.description)).map((t) => t.name);
  const unsafe = sem.length > 0 || instr.length > 0;
  const reasons = [...driftReasons];
  if (instr.length) reasons.push(`instruction-like text in ${instr.join(", ")}`);
  const semFindings: Finding[] = sem.map((f) => ({
    serverId, ts: now, kind: "semgrep",
    severity: f.severity === "ERROR" ? "critical" : f.severity === "WARNING" ? "high" : "low",
    detail: `${f.ruleId} in tool ${f.tool ?? "?"}`, evidence: f.message,
  }));
  const findings: Finding[] = [
    ...(firstSeen ? [{ serverId, ts: now, kind: "drift" as const, severity: "low" as const, detail: `first sight: no approved baseline yet; ${tools.length} tools served (${toolList})` }] : []),
    ...buildFindings(serverId, changedTools, newTools, instr, unsafe),
    ...semFindings,
    ...(sem.length ? [] : [{ serverId, ts: now, kind: "semgrep" as const, severity: "low" as const, detail: `Semgrep MCP rules: 0 findings in the served tool definitions` }]),
  ];

  // Akash: an open model writes the verdict from those findings (it phrases, never decides).
  const status = unsafe ? "rug_pull" : "clean";
  const score = unsafe ? 100 : 0;
  const summary = await triageSummary(name, status, score, findings);
  add({ key: "akash", output: summary, trace: TRACE.akash }, unsafe ? "bad" : "ok");

  // Senso: the verdict, with its evidence, becomes verified context.
  const verdict: Verdict = { serverId, ts: Date.now(), verdict: unsafe ? "rug_pull" : "clean", score, summary, sources: [...reasons, ...semFindings.map((f) => f.detail), ...(unsafe ? [DEADBUGZ] : [])] };
  const ref = await writeVerdict({ ...base, findings, verdict }, verdict);
  verdict.sources.unshift(`senso:${ref.id}`);
  add({ key: "senso", output: `Saved ${unsafe ? "UNSAFE" : "SAFE"} verdict ${String(ref.id).slice(0, 12)}…`, trace: ref.url ?? TRACE.senso }, unsafe ? "bad" : "ok");

  await ch.chInsertFindings(findings);
  await ch.chInsertVerdict(verdict);

  const evidence = [
    `${firstSeen ? "First sight: no approved baseline in ClickHouse yet." : `Drift vs the approved baseline in ClickHouse: ${driftReasons.join("; ")}.`}`,
    `Semgrep MCP rules on the served tool definitions: ${sem.length ? sem.map((f) => `${f.ruleId} in ${f.tool}`).join("; ") : "0 findings"}.`,
    `Akash triage: ${summary}`,
    `Verdict saved in Senso as ${ref.id}.`,
  ];

  if (!unsafe) {
    // Safe: these tools become the approved baseline.
    await ch.chWriteBaseline(serverId, name, tools);
    blackGate.release(serverId);
    const agentP = isClaude ? Promise.resolve(undefined) : agentReason(tools, TASK);
    const g = await guildStage(
      [`Gateway decision #${callNo}. Server: ${name}. Request: ${request}. Decision: APPROVE (new baseline).`, ...evidence].join("\n"),
      "APPROVE", "Approved · agent may connect", update,
    );
    add(g, "ok");
    store.upsert({ ...base, status: "clean", score: 0, findings, toolsBefore: tools, lastChecked: Date.now(), verdict });
    const result = await forward();
    const agent = await agentP;
    return finish({ tools: annotated, raw, review: true, detected: false, reasons, allowed: true, agentMessage: `${name} reviewed and approved.`, agent, result, summary, guildUrl: g.trace });
  }

  blackGate.quarantine(serverId, reasons.join("; "));
  // The agent's real answer, reasoning over Sauron's verdict (not pre-written).
  const agentP = isClaude
    ? Promise.resolve(undefined)
    : agentReason([{ name: "gateway_notice", description: `Not a callable tool. The gateway blocked ${name}, so none of its tools are available. Tell the user you can't get the weather and why: ${summary}` }], TASK);
  const g = await guildStage(
    [`Gateway decision #${callNo}. Server: ${name}. Request: ${request}. Decision: QUARANTINE.`, ...evidence, `Reference: ${DEADBUGZ}`].join("\n"),
    "QUARANTINE", "Quarantined · permanent block awaits a human", update,
  );
  add(g, "bad");

  store.upsert({ ...base, status: "quarantined", score: 100, findings, toolsAfter: tools, lastChecked: Date.now(), verdict });
  const ev = mkEvent(serverId, "quarantined", `Gate blocked ${name}: ${reasons.join("; ")}`); store.emit(ev); await ch.chInsertEvent(ev);

  const agent = await agentP;
  return finish({ tools: annotated, raw, review: true, detected: true, reasons, allowed: false, agentMessage: `Blocked: ${reasons.join("; ")}`, agent, summary, guildUrl: g.trace });
}

function buildFindings(serverId: string, changed: string[], appeared: string[], instr: string[], unsafe = true): Finding[] {
  const ts = Date.now();
  const out: Finding[] = [];
  if (changed.length) out.push({ serverId, ts, kind: "drift", severity: unsafe ? "critical" : "medium", detail: `description changed: ${changed.join(", ")}` });
  if (appeared.length) out.push({ serverId, ts, kind: "drift", severity: unsafe ? "high" : "medium", detail: `new tool after approval: ${appeared.join(", ")}` });
  if (instr.length) out.push({ serverId, ts, kind: "instruction_text", severity: "high", detail: `instruction-like text in ${instr.join(", ")}` });
  return out;
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
