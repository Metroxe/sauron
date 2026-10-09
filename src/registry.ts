// What Sauron watches: the live official MCP registry (for catalogue + scale),
// plus our own canary. The registry API is real and supports updated_since.
import { config } from "./config";
import type { AuthPosture, ServerRecord } from "./types";

export function canaryTarget(): ServerRecord {
  return {
    id: "canary:acme-weather-mcp",
    name: "acme-weather-mcp",
    url: config.canaryUrl,
    source: "canary",
    authPosture: "none",
    status: "pending",
    score: 0,
    firstSeen: Date.now(),
    lastChecked: null,
    findings: [],
    toolsBefore: [],
    toolsAfter: [],
  };
}

interface RegistryEntry {
  server?: { name?: string; description?: string; remotes?: { url?: string }[] };
  name?: string;
  _meta?: Record<string, any>;
}

// Pull the live registry. Each entry becomes a catalogued server. We don't
// fabricate auth posture: remote-with-no-declared-auth is 'unknown' until probed.
export async function fetchRegistry(limit = config.registryLimit): Promise<ServerRecord[]> {
  try {
    const url = `${config.registryUrl}?limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const j: any = await res.json();
    const entries: RegistryEntry[] = j.servers ?? j.data ?? [];
    const now = Date.now();
    const seen = new Set<string>();
    const out: ServerRecord[] = [];
    for (const e of entries) {
      const name = e.server?.name ?? e.name ?? "unknown";
      if (seen.has(name)) continue; // registry lists every version; one row per server
      seen.add(name);
      const remote = e.server?.remotes?.[0]?.url ?? "";
      out.push({
        id: `registry:${name}`,
        name,
        url: remote,
        source: "registry",
        authPosture: "unknown",
        status: "pending",
        score: 0,
        firstSeen: now,
        lastChecked: null,
        findings: [],
        toolsBefore: [],
        toolsAfter: [],
      });
    }
    return out;
  } catch (e) {
    console.warn("registry fetch failed:", (e as Error).message);
    return [];
  }
}

// Light, honest auth probe: try to open an MCP session with no credentials.
// 200-ish => no auth required; 401/403 => auth required.
export async function probeAuth(url: string): Promise<AuthPosture> {
  if (!url) return "unknown";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sauron-probe", version: "0.1" } },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return "apikey";
    if (res.status === 403) return "oauth";
    if (res.ok || res.status === 400) return "none"; // reachable without creds
    return "unknown";
  } catch {
    return "unknown";
  }
}
