// The Palantir = Senso, the verified-context store. Every verdict is written to
// Senso with its evidence, so an agent (or a human) can look up whether a server
// is safe BEFORE connecting — grounded in truthful sources, not a guess.
// Resilient: with no Senso key it writes to a local JSONL and returns a local id.
import { appendFile } from "node:fs/promises";
import { config } from "./config";
import type { ServerRecord, Verdict } from "./types";

const LOCAL = "demo/palantir.local.jsonl";

export interface PalantirRef {
  id: string;
  url?: string;
  backend: "senso" | "local";
}

export async function writeVerdict(rec: ServerRecord, v: Verdict): Promise<PalantirRef> {
  const title = `MCP verdict: ${rec.name} — ${v.verdict.toUpperCase()}`;
  const text = [
    `# ${rec.name}`,
    `URL: ${rec.url}`,
    `Verdict: ${v.verdict}  (score ${v.score}/100)`,
    `Summary: ${v.summary}`,
    ``,
    `## Findings`,
    ...rec.findings.map((f) => `- [${f.severity}] ${f.kind}: ${f.detail}`),
    ``,
    `## Sources`,
    ...v.sources.map((s) => `- ${s}`),
    ``,
    `Recorded ${new Date(v.ts).toISOString()} by Sauron.`,
  ].join("\n");

  if (config.senso.enabled && config.senso.apiKey) {
    try {
      const body: Record<string, unknown> = { title, text };
      if (config.senso.folderId) body.kb_folder_node_id = config.senso.folderId;
      const res = await fetch(`${config.senso.baseUrl}/org/kb/raw`, {
        method: "POST",
        headers: {
          "X-API-Key": config.senso.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const j: any = await res.json();
        // The KB node id opens this exact document in the Senso web app.
        const node = j.kb_node_id ?? j.id;
        const folder = config.senso.folderId;
        return {
          id: node ?? "senso",
          url: node
            ? `https://geo.senso.ai/knowledge-base?${folder ? `folder=${folder}&` : ""}node=${node}`
            : "https://geo.senso.ai/knowledge-base",
          backend: "senso",
        };
      }
      console.warn("Senso write non-OK:", res.status);
    } catch (e) {
      console.warn("Senso write failed:", (e as Error).message);
    }
  }

  // local fallback
  await appendFile(LOCAL, JSON.stringify({ title, text, ts: v.ts }) + "\n").catch(() => {});
  return { id: `local:${rec.id}`, backend: "local" };
}

// Retrieval the way an agent would check before connecting.
export async function askPalantir(query: string): Promise<{ answer: string; backend: "senso" | "local" }> {
  if (config.senso.enabled && config.senso.apiKey) {
    try {
      const res = await fetch(`${config.senso.baseUrl}/org/search`, {
        method: "POST",
        headers: { "X-API-Key": config.senso.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (res.ok) {
        const j: any = await res.json();
        return { answer: j.answer ?? JSON.stringify(j).slice(0, 400), backend: "senso" };
      }
    } catch {
      /* fall through */
    }
  }
  return { answer: "(local store — Senso not configured)", backend: "local" };
}
