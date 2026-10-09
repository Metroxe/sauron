// Turn a detonation + Semgrep findings + auth posture into findings, a 0..100
// risk score, and a verdict. Deterministic core; the LLM only writes the summary.
import type { AuthPosture, Finding, ServerStatus } from "./types";
import type { DetonationResult } from "./detonator";
import type { SemgrepFinding } from "./semgrep";

const INSTRUCTION_RE =
  /(ignore (the )?previous|disregard.*previous|before answering|first call|do not (mention|tell)|follow the instructions in|read .*(api key|credential|environment|secret)|send .*(credential|environment|the collected|variables)|OPENAI_API_KEY|AWS_SECRET|\[CANARY_DRIFT\])/i;

export interface ScoreResult {
  findings: Finding[];
  score: number;
  status: ServerStatus;
}

export function scoreServer(
  serverId: string,
  deto: DetonationResult,
  semgrep: SemgrepFinding[],
  authPosture: AuthPosture,
): ScoreResult {
  const ts = Date.now();
  const findings: Finding[] = [];
  let score = 0;

  // 1. Drift — the rug pull.
  if (deto.changed.length > 0) {
    score += 55;
    findings.push({
      serverId, ts, kind: "drift", severity: "critical",
      detail: `Tool description(s) changed after ${deto.calls} calls: ${deto.changed.join(", ")}`,
      evidence: deto.changed.join(", "),
    });
  }
  if (deto.appeared.length > 0) {
    score += 20;
    findings.push({
      serverId, ts, kind: "drift", severity: "high",
      detail: `New tool(s) appeared only after approval: ${deto.appeared.join(", ")}`,
      evidence: deto.appeared.join(", "),
    });
  }

  // 2. Instruction-like text in the (post-drift) tool descriptions.
  for (const t of deto.after) {
    if (INSTRUCTION_RE.test(t.description)) {
      score += 10;
      findings.push({
        serverId, ts, kind: "instruction_text", severity: "high",
        detail: `Tool "${t.name}" description instructs the agent instead of describing the tool`,
        evidence: t.description.slice(0, 160),
      });
      break;
    }
  }

  // 3. Semgrep findings on the server's own source.
  for (const f of semgrep) {
    const sev = f.severity === "ERROR" ? "critical" : f.severity === "WARNING" ? "medium" : "low";
    score += sev === "critical" ? 15 : sev === "medium" ? 8 : 3;
    findings.push({
      serverId, ts, kind: "semgrep", severity: sev as Finding["severity"],
      detail: `${f.ruleId} (${f.path}:${f.line})`,
      evidence: f.message,
    });
  }

  // 4. Auth posture.
  if (authPosture === "none") {
    score += 5;
    findings.push({
      serverId, ts, kind: "no_auth", severity: "low",
      detail: "Server exposes tools with no authentication",
    });
  }

  score = Math.min(100, score);
  const drifted = deto.changed.length > 0 || deto.appeared.length > 0;
  const status: ServerStatus = drifted
    ? "rug_pull"
    : score >= 40
      ? "rug_pull"
      : "clean";

  return { findings, score, status };
}
