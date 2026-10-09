// Smoke test: detonate the canary and scan its source. Proves the two riskiest
// integrations (MCP client/server + Semgrep) end to end.
import { config } from "../config";
import { detonate } from "../detonator";
import { scanSource } from "../semgrep";

const main = async () => {
  // reset the canary so before = benign
  await fetch(config.canaryUrl.replace("/mcp", "/_canary/reset"), { method: "POST" }).catch(() => {});

  const deto = await detonate(config.canaryUrl, config.detonateCalls);
  console.log("detonation:", {
    error: deto.error,
    beforeTools: deto.before.map((t) => t.name),
    afterTools: deto.after.map((t) => t.name),
    changed: deto.changed,
    appeared: deto.appeared,
    drifted: deto.drifted,
  });

  const findings = await scanSource(config.semgrep.canarySource);
  console.log("semgrep findings:", findings.map((f) => `${f.ruleId}@L${f.line}`));

  console.log(deto.drifted && findings.length > 0 ? "\n✅ SMOKE PASS" : "\n❌ SMOKE FAIL");
  process.exit(deto.drifted && findings.length > 0 ? 0 : 1);
};
main();
