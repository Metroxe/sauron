// The Black Gate = Guild. Guild hosts the watch agent and governs the gateway
// every one of your AI agents connects through. A rug pull is auto-quarantined
// (reversible). A permanent block waits for a human — the governance gate.
// The allowlist is authoritative locally; Guild verifies identity + holds the
// audit trail. Resilient: with no Guild key the gate still enforces locally.
import { config } from "./config";

class BlackGate {
  private quarantined = new Set<string>(); // auto-held, reversible
  private blocked = new Set<string>(); // permanent, human-approved
  private pending = new Map<string, string>(); // id -> reason, awaiting human
  guildOk = false;
  guildIdentity = "";
  guildAgents = 0;

  async verifyGuild() {
    if (!config.guild.enabled || !config.guild.apiKey) return;
    try {
      const me = await fetch(`${config.guild.baseUrl}/me`, {
        headers: { authorization: `Bearer ${config.guild.apiKey}` },
      });
      if (me.ok) {
        const j: any = await me.json();
        this.guildOk = true;
        this.guildIdentity = j.email ?? j.name ?? j.id ?? "guild";
      }
      const ag = await fetch(`${config.guild.baseUrl}/agents`, {
        headers: { authorization: `Bearer ${config.guild.apiKey}` },
      });
      if (ag.ok) {
        const j: any = await ag.json();
        this.guildAgents = (j.items ?? j.agents ?? j.data ?? []).length;
      }
    } catch (e) {
      console.warn("Guild verify failed:", (e as Error).message);
    }
  }

  // Record one gate decision as a real Guild session. The Black Gate agent
  // (hosted on Guild) reads the evidence and writes the decision record; the
  // session page is the per-run trace. Returns as soon as the session exists.
  async openDecision(prompt: string): Promise<{ id?: string; sessionUrl?: string }> {
    const { apiKey, baseUrl, workspace, agentId, enabled } = config.guild;
    if (!enabled || !apiKey || !workspace || !agentId) return {};
    try {
      const res = await fetch(`${baseUrl}/workspaces/${encodeURIComponent(workspace)}/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ session_type: "chat", agent_id: agentId, initial_prompt: prompt }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { console.warn("Guild session non-OK:", res.status); return {}; }
      const s: any = await res.json();
      return { id: s.id, sessionUrl: s.session_url ?? (s.id ? `https://app.guild.ai/sessions/${s.id}` : undefined) };
    } catch (e) {
      console.warn("Guild session failed:", (e as Error).message);
      return {};
    }
  }

  // Wait for the Black Gate agent to finish (~9 s), then read its decision.
  // Event reads hang while a session is running, so poll the session status first.
  async decisionReply(id: string, waitMs = 30000): Promise<string | undefined> {
    const { apiKey, baseUrl } = config.guild;
    const headers = { authorization: `Bearer ${apiKey}` };
    const get = (path: string) =>
      fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));
      const s: any = await get(`/sessions/${id}`);
      if (s?.root_task?.status !== "DONE") continue;
      const ev: any = await get(`/sessions/${id}/events?limit=8`);
      const msg = (ev?.items ?? []).find((e: any) => typeof e.content?.text === "string" && e.content.text.includes("DECISION"));
      return msg ? String(msg.content.text) : undefined;
    }
    return undefined;
  }

  isAllowed(id: string) {
    return !this.blocked.has(id) && !this.quarantined.has(id);
  }

  quarantine(id: string, reason: string) {
    this.quarantined.add(id);
    this.pending.set(id, reason); // offer a permanent block to a human
  }

  requestBlock(id: string, reason: string) {
    this.pending.set(id, reason);
  }

  approveBlock(id: string) {
    this.quarantined.delete(id);
    this.pending.delete(id);
    this.blocked.add(id);
  }

  release(id: string) {
    this.quarantined.delete(id);
    this.blocked.delete(id);
    this.pending.delete(id);
  }

  state() {
    return {
      guildOk: this.guildOk,
      guildIdentity: this.guildIdentity,
      guildAgents: this.guildAgents,
      quarantined: [...this.quarantined],
      blocked: [...this.blocked],
      pending: [...this.pending.entries()].map(([id, reason]) => ({ id, reason })),
    };
  }
}

export const blackGate = new BlackGate();
