// ClickHouse: the real-time backbone. Every snapshot/finding/verdict/event is a
// row. Resilient: if ClickHouse is unreachable the app still runs (the live
// dashboard is driven by the in-memory store); we just lose the durable rows.
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { config } from "./config";
import type { Finding, ServerRecord, Snapshot, ToolDescriptor, Verdict, WatchEvent } from "./types";

let client: ClickHouseClient | null = null;
let ready = false;

export function chReady() {
  return ready;
}

export async function initClickHouse(): Promise<boolean> {
  if (!config.clickhouse.enabled) return false;
  try {
    client = createClient({
      url: config.clickhouse.url,
      username: config.clickhouse.user,
      password: config.clickhouse.password,
      // connect to default first so we can CREATE DATABASE
      database: "default",
      request_timeout: 20000,
    });
    await client.command({ query: "CREATE DATABASE IF NOT EXISTS sauron" });
    const ddl = [
      `CREATE TABLE IF NOT EXISTS sauron.tool_snapshots (
        server_id String, server_name String, ts DateTime64(3),
        phase LowCardinality(String), call_count UInt32,
        tool_name String, tool_desc String, tool_desc_hash String
      ) ENGINE = MergeTree ORDER BY (server_id, tool_name, ts)`,
      `CREATE TABLE IF NOT EXISTS sauron.server_registry (
        server_id String, name String, url String,
        source LowCardinality(String), auth_posture LowCardinality(String),
        ts DateTime64(3)
      ) ENGINE = ReplacingMergeTree(ts) ORDER BY server_id`,
      `CREATE TABLE IF NOT EXISTS sauron.findings (
        server_id String, ts DateTime64(3), kind LowCardinality(String),
        severity LowCardinality(String), detail String, evidence String
      ) ENGINE = MergeTree ORDER BY (server_id, ts)`,
      `CREATE TABLE IF NOT EXISTS sauron.verdicts (
        server_id String, ts DateTime64(3), verdict LowCardinality(String),
        score Float64, summary String, sources String
      ) ENGINE = MergeTree ORDER BY (server_id, ts)`,
      `CREATE TABLE IF NOT EXISTS sauron.events (
        ts DateTime64(3), server_id String, type LowCardinality(String), detail String
      ) ENGINE = MergeTree ORDER BY ts`,
    ];
    for (const q of ddl) await client.command({ query: q });
    ready = true;
    console.log("✓ ClickHouse ready:", config.clickhouse.url);
    return true;
  } catch (e) {
    ready = false;
    console.warn(
      "⚠ ClickHouse unavailable, running from memory only:",
      (e as Error).message,
    );
    return false;
  }
}

const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

async function insert(table: string, rows: Record<string, unknown>[]) {
  if (!ready || !client || rows.length === 0) return;
  try {
    await client.insert({ table, values: rows, format: "JSONEachRow" });
  } catch (e) {
    console.warn(`CH insert ${table} failed:`, (e as Error).message);
  }
}

export async function chInsertSnapshot(s: Snapshot, serverName: string) {
  await insert(
    "sauron.tool_snapshots",
    s.tools.map((t) => ({
      server_id: s.serverId,
      server_name: serverName,
      ts: iso(s.ts),
      phase: s.phase,
      call_count: s.callCount,
      tool_name: t.name,
      tool_desc: t.description,
      tool_desc_hash: t.descHash,
    })),
  );
}

export async function chInsertFindings(fs: Finding[]) {
  await insert(
    "sauron.findings",
    fs.map((f) => ({
      server_id: f.serverId,
      ts: iso(f.ts),
      kind: f.kind,
      severity: f.severity,
      detail: f.detail,
      evidence: f.evidence ?? "",
    })),
  );
}

export async function chInsertVerdict(v: Verdict) {
  await insert("sauron.verdicts", [
    {
      server_id: v.serverId,
      ts: iso(v.ts),
      verdict: v.verdict,
      score: v.score,
      summary: v.summary,
      sources: v.sources.join(" "),
    },
  ]);
}

export async function chInsertEvent(e: WatchEvent) {
  await insert("sauron.events", [
    { ts: iso(e.ts), server_id: e.serverId, type: e.type, detail: e.detail },
  ]);
}

export async function chUpsertRegistry(recs: ServerRecord[]) {
  await insert(
    "sauron.server_registry",
    recs.map((r) => ({
      server_id: r.id,
      name: r.name,
      url: r.url,
      source: r.source,
      auth_posture: r.authPosture,
      ts: iso(Date.now()),
    })),
  );
}

// ── ClickHouse as the drift detector ──
// The approved baseline of a server's tools lives here. First sight → baseline.
// Later → compare the current tools against this stored baseline.
export async function chGetBaseline(serverId: string, sinceMs = 0): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!ready || !client) return m;
  try {
    const q = await client.query({
      query: `SELECT tool_name, argMax(tool_desc_hash, ts) AS h
              FROM sauron.tool_snapshots
              WHERE server_id = {id:String} AND phase = 'baseline' AND ts > {since:DateTime64(3)}
              GROUP BY tool_name`,
      query_params: { id: serverId, since: iso(sinceMs) },
      format: "JSON",
    });
    const j = (await q.json()) as { data: { tool_name: string; h: string }[] };
    for (const r of j.data) m.set(r.tool_name, r.h);
  } catch (e) {
    console.warn("chGetBaseline failed:", (e as Error).message);
  }
  return m;
}

// A ClickHouse Cloud console link that opens a query tab pre-filled with SQL.
// The console takes the query base64-encoded; the viewer clicks Run.
export function chQueryUrl(sql: string): string {
  const svc = config.clickhouse.serviceId;
  if (!svc) return "https://console.clickhouse.cloud/";
  const q = Buffer.from(sql.trim(), "utf8").toString("base64");
  return `https://console.clickhouse.cloud/services/${svc}/console/newQuery?query=${encodeURIComponent(q)}&database=sauron`;
}

// The SQL behind one run: the approved baseline vs. what the server served.
export function chRunSql(serverId: string, sinceMs: number, callNo: number): string {
  return `-- Sauron call #${callNo}: approved baseline vs. what ${serverId} served
SELECT ts, phase, tool_name, tool_desc_hash, tool_desc
FROM sauron.tool_snapshots
WHERE server_id = '${serverId.replace(/'/g, "")}' AND ts > '${iso(sinceMs)}'
ORDER BY ts DESC, tool_name
LIMIT 20`;
}

export async function chWriteBaseline(serverId: string, serverName: string, tools: ToolDescriptor[]) {
  await insert(
    "sauron.tool_snapshots",
    tools.map((t) => ({
      server_id: serverId, server_name: serverName, ts: iso(Date.now()),
      phase: "baseline", call_count: 0, tool_name: t.name, tool_desc: t.description, tool_desc_hash: t.descHash,
    })),
  );
}

export interface DriftRow {
  server_id: string;
  tool_name: string;
  before_hash: string;
  after_hash: string;
}

// The catch, as SQL: tools whose description changed after the calls, or tools
// that only appeared afterwards. Returns rows + query latency in ms.
export async function chDriftQuery(): Promise<{ rows: DriftRow[]; ms: number; scanned: number }> {
  if (!ready || !client) return { rows: [], ms: 0, scanned: 0 };
  const query = `
    SELECT a.server_id AS server_id, a.tool_name AS tool_name,
           b.h AS before_hash, a.h AS after_hash
    FROM (
      SELECT server_id, tool_name, argMax(tool_desc_hash, ts) h
      FROM sauron.tool_snapshots WHERE phase='after' GROUP BY server_id, tool_name
    ) a
    LEFT JOIN (
      SELECT server_id, tool_name, argMax(tool_desc_hash, ts) h
      FROM sauron.tool_snapshots WHERE phase='before' GROUP BY server_id, tool_name
    ) b USING (server_id, tool_name)
    WHERE a.h != b.h OR b.h = ''`;
  const rs = await client.query({ query, format: "JSON" });
  const j = (await rs.json()) as { data: DriftRow[]; statistics?: { elapsed: number }; rows_before_limit_at_least?: number };
  const total = await client.query({
    query: "SELECT count() c FROM sauron.tool_snapshots",
    format: "JSON",
  });
  const tj = (await total.json()) as { data: { c: string }[] };
  return {
    rows: j.data,
    ms: Math.round((j.statistics?.elapsed ?? 0) * 1000),
    scanned: Number(tj.data?.[0]?.c ?? 0),
  };
}

export async function chStats(): Promise<{ snapshotRows: number; servers: number; pctNoAuth: number }> {
  if (!ready || !client) return { snapshotRows: 0, servers: 0, pctNoAuth: 0 };
  try {
    const q = await client.query({
      query: `SELECT
        (SELECT count() FROM sauron.tool_snapshots) AS snapshot_rows,
        (SELECT count() FROM sauron.server_registry FINAL) AS servers,
        (SELECT round(100 * countIf(auth_posture='none') / greatest(countIf(auth_posture!='unknown'),1), 1)
           FROM sauron.server_registry FINAL) AS pct_no_auth`,
      format: "JSON",
    });
    const j = (await q.json()) as { data: { snapshot_rows: string; servers: string; pct_no_auth: number }[] };
    const r = j.data[0];
    return {
      snapshotRows: Number(r?.snapshot_rows ?? 0),
      servers: Number(r?.servers ?? 0),
      pctNoAuth: Number(r?.pct_no_auth ?? 0),
    };
  } catch {
    return { snapshotRows: 0, servers: 0, pctNoAuth: 0 };
  }
}
