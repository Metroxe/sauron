// Core domain types for Sauron — the Eye that watches every MCP server.

export type ServerSource = "registry" | "canary" | "pr";

export type ServerStatus =
  | "pending" // seen, not yet detonated
  | "detonating" // in Mount Doom right now
  | "clean" // detonated, no drift
  | "rug_pull" // tools changed after approval — the Deadbugz pattern
  | "quarantined" // auto-held at the Black Gate (reversible)
  | "blocked"; // permanently blocked (needs human approval)

export type AuthPosture = "none" | "apikey" | "oauth" | "unknown";

export interface ToolDescriptor {
  name: string;
  description: string;
  descHash: string;
}

export interface Snapshot {
  serverId: string;
  ts: number;
  phase: "before" | "after" | "check";
  callCount: number;
  tools: ToolDescriptor[];
}

export type FindingKind = "drift" | "semgrep" | "no_auth" | "instruction_text";

export interface Finding {
  serverId: string;
  ts: number;
  kind: FindingKind;
  severity: "low" | "medium" | "high" | "critical";
  detail: string;
  evidence?: string;
}

export interface Verdict {
  serverId: string;
  ts: number;
  verdict: ServerStatus;
  score: number; // 0 (safe) .. 100 (hostile)
  sources: string[]; // evidence ids / urls — the "truthful sources"
  summary: string;
}

export interface ServerRecord {
  id: string;
  name: string;
  url: string;
  source: ServerSource;
  authPosture: AuthPosture;
  status: ServerStatus;
  score: number;
  firstSeen: number;
  lastChecked: number | null;
  findings: Finding[];
  toolsBefore: ToolDescriptor[];
  toolsAfter: ToolDescriptor[];
  verdict?: Verdict;
}

export type EventType =
  | "seen"
  | "detonating"
  | "snapshot"
  | "finding"
  | "verdict"
  | "quarantined"
  | "blocked"
  | "gate_denied"
  | "stage"
  | "info";

export interface WatchEvent {
  ts: number;
  serverId: string;
  type: EventType;
  detail: string;
}
