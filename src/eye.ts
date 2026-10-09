// The Eye: the orchestration loop. For each target — detonate in Mount Doom,
// snapshot to ClickHouse, scan with Semgrep, score, summarise on Akash, write
// the verdict to the Palantir (Senso), and quarantine at the Black Gate (Guild).
import { config } from "./config";
import { store, mkEvent } from "./store";
import { canaryTarget, fetchRegistry, probeAuth } from "./registry";
import { detonate } from "./detonator";
import { scanSource } from "./semgrep";
import { scoreServer } from "./scorer";
import { triageSummary } from "./akash";
import { writeVerdict } from "./palantir";
import { blackGate } from "./blackgate";
import * as ch from "./clickhouse";
import type { ServerRecord, Snapshot, Verdict, EventType } from "./types";

const CANARY_ID = "canary:acme-weather-mcp";
const DEADBUGZ = "https://www.pillar.security/blog/deadbugz-currently-active-mcp-supply-chain-campaign";

async function emit(serverId: string, type: EventType, detail: string) {
  const ev = mkEvent(serverId, type, detail);
  store.emit(ev);
  await ch.chInsertEvent(ev);
}

export async function detonateServer(id: string) {
  const rec = store.get(id);
  if (!rec) return;

  // Reset the canary so each run is a clean benign → drift (repeatable demo).
  if (rec.source === "canary") {
    await fetch(config.canaryUrl.replace("/mcp", "/_canary/reset"), { method: "POST" }).catch(() => {});
  }

  store.patch(id, { status: "detonating" });
  await emit(id, "detonating", `Mount Doom: detonating ${rec.name}`);

  const deto = await detonate(rec.url, config.detonateCalls);
  if (deto.error) {
    store.patch(id, { status: "pending" });
    await emit(id, "info", `${rec.name} unreachable: ${deto.error}`);
    return;
  }

  const now = Date.now();
  const before: Snapshot = { serverId: id, ts: now, phase: "before", callCount: 0, tools: deto.before };
  const after: Snapshot = { serverId: id, ts: now + 1, phase: "after", callCount: deto.calls, tools: deto.after };
  await ch.chInsertSnapshot(before, rec.name);
  await ch.chInsertSnapshot(after, rec.name);
  await emit(id, "snapshot", `tools: ${deto.before.length} before → ${deto.after.length} after (${deto.calls} calls)`);

  // Scan the server's own source (we have the canary's; registry servers are URL-only).
  const semgrep = rec.source === "canary" ? await scanSource(config.semgrep.canarySource) : [];

  const { findings, score, status } = scoreServer(id, deto, semgrep, rec.authPosture);
  for (const f of findings) await emit(id, "finding", `${f.kind}: ${f.detail}`);
  await ch.chInsertFindings(findings);

  const summary = await triageSummary(rec.name, status, score, findings);

  const verdict: Verdict = {
    serverId: id,
    ts: Date.now(),
    verdict: status,
    score,
    summary,
    sources: [
      `detonation: ${deto.changed.length} changed, ${deto.appeared.length} new tool(s)`,
      ...semgrep.map((s) => `semgrep:${s.ruleId}@${s.path}:${s.line}`),
      DEADBUGZ,
    ],
  };

  const updated: ServerRecord = {
    ...rec,
    status,
    score,
    findings,
    toolsBefore: deto.before,
    toolsAfter: deto.after,
    lastChecked: Date.now(),
    verdict,
  };
  store.upsert(updated);

  // Palantir (Senso): verified-context record, with its sources.
  const ref = await writeVerdict(updated, verdict);
  verdict.sources.unshift(`senso:${ref.id}`);
  await ch.chInsertVerdict(verdict);
  await emit(id, "verdict", `${status.toUpperCase()} score ${score}/100 — ${summary}`);

  // Black Gate (Guild): auto-quarantine the rug pull; a permanent block waits for a human.
  if (status === "rug_pull") {
    blackGate.quarantine(id, `rug pull: ${[...deto.changed, ...deto.appeared].join(", ")}`);
    store.patch(id, { status: "quarantined" });
    await emit(id, "quarantined", `Black Gate: ${rec.name} quarantined. Permanent block awaits human approval.`);
  }
}

export async function catalogRegistry(): Promise<number> {
  const servers = await fetchRegistry();
  for (const s of servers) if (!store.get(s.id)) store.upsert(s);

  // Light, real auth probe on a sample → a measured no-auth rate (not fabricated).
  const sample = servers.filter((s) => s.url).slice(0, 12);
  const res = await Promise.allSettled(sample.map((s) => probeAuth(s.url)));
  res.forEach((r, i) => {
    if (r.status === "fulfilled") {
      sample[i].authPosture = r.value;
      const rec = store.get(sample[i].id);
      if (rec) store.upsert({ ...rec, authPosture: r.value });
    }
  });

  await ch.chUpsertRegistry(servers);
  if (servers.length) await emit("registry", "info", `catalogued ${servers.length} servers from the MCP registry`);
  return servers.length;
}

export async function runOnce() {
  if (!store.get(CANARY_ID)) store.upsert(canaryTarget());
  await detonateServer(CANARY_ID);
}

export async function bootstrap() {
  await ch.initClickHouse();
  await blackGate.verifyGuild();
  store.upsert(canaryTarget());
  await catalogRegistry().catch(() => 0);
}

export function startEye(intervalMs = 0) {
  bootstrap().then(() => runOnce());
  if (intervalMs > 0) setInterval(() => runOnce().catch(() => {}), intervalMs);
}
