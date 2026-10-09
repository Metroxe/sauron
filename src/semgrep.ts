// Semgrep: scan an MCP server's source with our custom MCP rules. Resilient —
// if the CLI isn't installed we return no findings rather than crashing.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config";

const pexec = promisify(execFile);

function semgrepBin(): string | null {
  const candidates = ["semgrep", join(homedir(), ".local/bin/semgrep")];
  for (const c of candidates) {
    if (c === "semgrep") return c; // assume on PATH; execFile will fail over
    if (existsSync(c)) return c;
  }
  return null;
}

export interface SemgrepFinding {
  ruleId: string;
  line: number;
  severity: string;
  message: string;
  path: string;
}

export async function scanSource(path: string): Promise<SemgrepFinding[]> {
  if (!config.semgrep.enabled) return [];
  const bin = semgrepBin();
  if (!bin) return [];
  try {
    const { stdout } = await pexec(
      bin,
      [
        "--config", config.semgrep.rules,
        path,
        "--no-git-ignore",
        "--json",
        "--quiet",
        "--metrics=off",
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    ).catch((e: any) => ({ stdout: e.stdout ?? "" })); // semgrep exits non-zero when it finds things
    const j = JSON.parse(stdout || "{}");
    return (j.results ?? []).map((r: any) => ({
      ruleId: String(r.check_id).split(".").pop(),
      line: r.start?.line ?? 0,
      severity: r.extra?.severity ?? "INFO",
      message: (r.extra?.message ?? "").trim().split("\n")[0],
      path: r.path,
    }));
  } catch (e) {
    console.warn("semgrep scan failed:", (e as Error).message);
    return [];
  }
}
