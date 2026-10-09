// A scripted one-shot for a terminal demo / sanity check: bootstrap, detonate
// the canary, and narrate the catch. The dashboard is the real demo surface.
import { bootstrap, runOnce } from "../eye";
import { store } from "../store";
import { blackGate } from "../blackgate";

await bootstrap();
console.log("\n— Sauron: detonating the canary —\n");
await runOnce();

const r = store.get("canary:acme-weather-mcp");
if (r) {
  console.log("server :", r.name, r.url);
  console.log("status :", r.status, `(score ${r.score})`);
  console.log("before :", (r.toolsBefore || []).map((t) => t.name).join(", "));
  console.log("after  :", (r.toolsAfter || []).map((t) => t.name).join(", "));
  console.log("findings:");
  for (const f of r.findings) console.log(`  [${f.severity}] ${f.kind}: ${f.detail}`);
  console.log("verdict :", r.verdict?.summary);
  console.log("sources :", r.verdict?.sources.join("\n           "));
  console.log("gate    :", blackGate.isAllowed(r.id) ? "ALLOWED" : "DENIED / quarantined");
}
process.exit(0);
