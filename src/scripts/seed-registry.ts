// Seed ClickHouse so the scale + latency story is real on screen: catalogue the
// live MCP registry, probe a sample for auth posture (a real measured number),
// and generate a large history of tool snapshots so the drift query runs over
// a big table. Seeded rows use the `seed:` prefix and are clearly synthetic.
import { createClient } from "@clickhouse/client";
import { createHash } from "node:crypto";
import { config } from "../config";
import { initClickHouse, chUpsertRegistry } from "../clickhouse";
import { fetchRegistry, probeAuth } from "../registry";

const SEED_SERVERS = Number(process.env.SEED_SERVERS ?? 12500);
const TOOLS_PER = 4;
const DRIFT_FRACTION = 0.04;
const PROBE_SAMPLE = Number(process.env.PROBE_SAMPLE ?? 20);
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

async function main() {
  const ready = await initClickHouse();
  if (!ready) { console.error("ClickHouse not reachable"); process.exit(1); }

  // 1. Catalogue the live registry (real).
  const servers = await fetchRegistry(100);
  console.log(`catalogued ${servers.length} live registry servers`);

  // 2. Probe a sample for auth posture (real, measured).
  const sample = servers.filter((s) => s.url).slice(0, PROBE_SAMPLE);
  const postures = await Promise.allSettled(sample.map((s) => probeAuth(s.url)));
  postures.forEach((p, i) => { if (p.status === "fulfilled") sample[i].authPosture = p.value; });
  const probed = sample.filter((s) => s.authPosture !== "unknown");
  const noAuth = probed.filter((s) => s.authPosture === "none").length;
  console.log(`probed ${sample.length}, resolved ${probed.length}, no-auth ${noAuth}`);
  await chUpsertRegistry(servers);

  // 3. Generate a large snapshot history for the scale story.
  const client = createClient({
    url: config.clickhouse.url, username: config.clickhouse.user,
    password: config.clickhouse.password, database: "default", request_timeout: 60000,
  });
  const now = Date.now();
  const batch: any[] = [];
  let rows = 0, drifting = 0;
  const flush = async () => {
    if (!batch.length) return;
    await client.insert({ table: "sauron.tool_snapshots", values: batch.splice(0), format: "JSONEachRow" });
  };
  for (let s = 0; s < SEED_SERVERS; s++) {
    const sid = `seed:srv-${String(s).padStart(5, "0")}`;
    const drifts = Math.random() < DRIFT_FRACTION;
    if (drifts) drifting++;
    for (let t = 0; t < TOOLS_PER; t++) {
      const base = `tool_${t} of ${sid}`;
      const beforeHash = hash(base);
      const afterHash = drifts && t === 0 ? hash(base + " [CANARY_DRIFT]") : beforeHash;
      batch.push({ server_id: sid, server_name: sid, ts: iso(now - 60000), phase: "before", call_count: 0, tool_name: `tool_${t}`, tool_desc: base, tool_desc_hash: beforeHash });
      batch.push({ server_id: sid, server_name: sid, ts: iso(now), phase: "after", call_count: 4, tool_name: `tool_${t}`, tool_desc: base, tool_desc_hash: afterHash });
      rows += 2;
    }
    if (batch.length >= 10000) await flush();
  }
  await flush();
  await client.close();
  console.log(`✓ seeded ${rows.toLocaleString()} snapshot rows across ${SEED_SERVERS.toLocaleString()} servers (${drifting} drifting)`);
}

main();
