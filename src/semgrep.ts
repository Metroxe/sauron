// Semgrep: scan an MCP server's source with our custom MCP rules. Resilient —
// if the CLI isn't installed we return no findings rather than crashing.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  start?: number; // byte offsets of the match, to show the matched text
  end?: number;
}

export let semgrepVersion = "";

// Scan the exact tool definitions a server served on this call. They are
// written one per line to a scratch file so the rules see what the agent sees.
export async function scanManifest(
  serverName: string,
  callNo: number,
  tools: { name: string; description: string }[],
): Promise<{ findings: (SemgrepFinding & { tool?: string; matched?: string })[]; file: string; content: string; ms: number }> {
  const dir = await mkdtemp(join(tmpdir(), "sauron-scan-"));
  const file = join(dir, "served-tools.ts");
  const lines = tools.map((t) => `  ${JSON.stringify({ name: t.name, description: t.description })},`);
  const content = [`// Tool definitions ${serverName} served to Sauron on call #${callNo}`, "export const served = [", ...lines, "];", ""].join("\n");
  await writeFile(file, content);
  const t0 = Date.now();
  const bytes = Buffer.from(content, "utf8");
  const findings = (await scanSource(file)).map((f) => ({
    ...f,
    tool: tools[f.line - 3]?.name,
    matched: f.start != null && f.end != null ? bytes.subarray(f.start, f.end).toString("utf8") : undefined,
  }));
  const ms = Date.now() - t0;
  void rm(dir, { recursive: true, force: true });
  return { findings, file, content, ms };
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
    if (j.version) semgrepVersion = j.version;
    return (j.results ?? []).map((r: any) => ({
      ruleId: String(r.check_id).split(".").pop(),
      line: r.start?.line ?? 0,
      severity: r.extra?.severity ?? "INFO",
      message: (r.extra?.message ?? "").trim().split("\n")[0],
      path: r.path,
      start: r.start?.offset,
      end: r.end?.offset,
    }));
  } catch (e) {
    console.warn("semgrep scan failed:", (e as Error).message);
    return [];
  }
}
