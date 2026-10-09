// Mount Doom: the detonation sandbox. Connect to an MCP server, snapshot its
// tools, make a few harmless calls, snapshot again, and diff. A description that
// changed, or a tool that only appeared after the calls, is a rug pull.
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDescriptor } from "./types";

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export interface DetonationResult {
  before: ToolDescriptor[];
  after: ToolDescriptor[];
  changed: string[]; // tool names whose description changed
  appeared: string[]; // tools present only after the calls
  disappeared: string[];
  drifted: boolean;
  calls: number;
  error?: string;
}

function toDescriptors(tools: { name: string; description?: string }[]): ToolDescriptor[] {
  return tools.map((t) => {
    const description = t.description ?? "";
    return { name: t.name, description, descHash: hash(description) };
  });
}

// Build a minimal, harmless argument object from a tool's input schema.
function dummyArgs(schema: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = schema?.properties ?? {};
  for (const key of schema?.required ?? []) {
    const t = props[key]?.type;
    out[key] = t === "number" || t === "integer" ? 0 : t === "boolean" ? false : "test";
  }
  return out;
}

// One-shot: connect, list the tools the server advertises right now, close.
// This is the "Get MCP definition" step the gateway runs on every agent call.
export async function inspect(url: string): Promise<{ tools: ToolDescriptor[]; error?: string }> {
  const client = new Client({ name: "sauron-gate", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport);
    const list = await client.listTools();
    return { tools: toDescriptors(list.tools) };
  } catch (e) {
    return { tools: [], error: (e as Error).message };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

// Forward a single tool call (used only when the gate ALLOWS the server).
export async function callOne(
  url: string, name: string, args: Record<string, unknown>,
): Promise<{ text: string; error?: string }> {
  const client = new Client({ name: "sauron-gate", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport);
    const r: any = await client.callTool({ name, arguments: args });
    const text = (r?.content ?? []).map((c: any) => c.text ?? "").join(" ").trim();
    return { text: text || "(no content)" };
  } catch (e) {
    return { text: "", error: (e as Error).message };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

export async function detonate(url: string, calls: number): Promise<DetonationResult> {
  const client = new Client({ name: "sauron-detonator", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const empty: DetonationResult = {
    before: [], after: [], changed: [], appeared: [], disappeared: [],
    drifted: false, calls,
  };
  try {
    await client.connect(transport);

    const beforeList = await client.listTools();
    const before = toDescriptors(beforeList.tools);

    // Make `calls` harmless calls to the first callable tool.
    const first = beforeList.tools[0];
    if (first) {
      const args = dummyArgs(first.inputSchema);
      for (let i = 0; i < calls; i++) {
        try {
          await client.callTool({ name: first.name, arguments: args });
        } catch {
          /* a tool error still counts as a call; keep going */
        }
      }
    }

    const afterList = await client.listTools();
    const after = toDescriptors(afterList.tools);

    const beforeMap = new Map(before.map((t) => [t.name, t.descHash]));
    const afterMap = new Map(after.map((t) => [t.name, t.descHash]));
    const changed = [...afterMap.keys()].filter(
      (n) => beforeMap.has(n) && beforeMap.get(n) !== afterMap.get(n),
    );
    const appeared = [...afterMap.keys()].filter((n) => !beforeMap.has(n));
    const disappeared = [...beforeMap.keys()].filter((n) => !afterMap.has(n));

    return {
      before, after, changed, appeared, disappeared,
      drifted: changed.length > 0 || appeared.length > 0,
      calls,
    };
  } catch (e) {
    return { ...empty, error: (e as Error).message };
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}
