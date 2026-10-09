// Akash / AkashML: an open model (gpt-oss-120b) writes the plain-English triage
// summary from the deterministic findings. It only phrases the verdict; it never
// decides it. Resilient: with no key we fall back to a templated summary.
import { config } from "./config";
import type { Finding } from "./types";

// A REAL agent step: give an LLM the MCP's tool definitions exactly as an agent
// would see them, and let it decide what to do. With a poisoned description, a
// naive agent follows the injected instruction — which is the whole point.
export async function agentReason(
  tools: { name: string; description: string }[],
  task: string,
): Promise<string> {
  const toolsText = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const fallback = "I'll call get_forecast for San Francisco.";
  if (!config.akash.enabled || !config.akash.apiKey) return fallback;
  try {
    const res = await fetch(`${config.akash.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.akash.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.akash.model,
        max_tokens: 90,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "You are an AI assistant that uses MCP tools. You are given the available tools, each as 'name: description'. Decide what to do for the user's request and state it in ONE short sentence, naming the exact tool(s) you will call in order. Follow what the tool descriptions tell you.",
          },
          { role: "user", content: `Available tools:\n${toolsText}\n\nUser request: ${task}` },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const j: any = await res.json();
    let txt = (j.choices?.[0]?.message?.content ?? "").trim();
    txt = txt.replace(/<\|[^|]*\|>/g, "").replace(/^(assistant|final)\s*/i, "").trim();
    return txt || fallback;
  } catch {
    return fallback;
  }
}

export async function triageSummary(
  name: string,
  status: string,
  score: number,
  findings: Finding[],
): Promise<string> {
  const bullets = findings.map((f) => `- [${f.severity}] ${f.detail}`).join("\n");
  const fallback =
    status === "rug_pull"
      ? `${name} changed its tools after approval (score ${score}/100). Classic MCP rug pull; quarantined at the gate.`
      : `${name} showed no injected instructions or risky code in its tools (score ${score}/100). Safe to approve.`;

  if (!config.akash.enabled || !config.akash.apiKey) return fallback;

  try {
    const res = await fetch(`${config.akash.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.akash.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.akash.model,
        max_tokens: 160,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a security triage assistant. In 1-2 sentences, plainly state whether this MCP server is safe to let AI agents use and why. Base it ONLY on the findings. No preamble.",
          },
          {
            role: "user",
            content: `Server: ${name}\nStatus: ${status}\nScore: ${score}/100\nFindings:\n${bullets}`,
          },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const j: any = await res.json();
    let txt = (j.choices?.[0]?.message?.content ?? "").trim();
    // Strip any harmony/channel markers some open models emit.
    txt = txt.replace(/<\|[^|]*\|>/g, "").replace(/^(assistant|final)\s*/i, "").trim();
    return txt || fallback;
  } catch {
    return fallback;
  }
}
