// Central config. Every sponsor integration is real where an account exists,
// and a safe local stand-in otherwise (toggled by env). The happy path runs
// end to end with zero accounts: ClickHouse via Docker, canary MCP over HTTP,
// local stand-ins for Senso (Palantir) and Guild (Black Gate).

import process from "node:process";

const bool = (v: string | undefined, def: boolean) =>
  v === undefined ? def : /^(1|true|yes|on)$/i.test(v);

export const config = {
  // The Eye (dashboard + API + gateway)
  port: Number(process.env.SAURON_PORT ?? 7777),

  // Mount Doom (the detonation sandbox): how many harmless calls before we
  // re-list the tools and diff. Deadbugz turned on call #3.
  detonateCalls: Number(process.env.SAURON_DETONATE_CALLS ?? 4),

  // The canary MCP server we detonate live in the demo.
  canaryUrl: process.env.CANARY_URL ?? "http://localhost:8808/mcp",
  canaryPort: Number(process.env.CANARY_PORT ?? 8808),
  // The canary flips its tools after this many calls (its "rug pull").
  canaryFlipAfter: Number(process.env.CANARY_FLIP_AFTER ?? 3),

  // Official MCP registry (real, live, supports updated_since).
  registryUrl:
    process.env.MCP_REGISTRY_URL ??
    "https://registry.modelcontextprotocol.io/v0/servers",
  registryLimit: Number(process.env.MCP_REGISTRY_LIMIT ?? 100),

  // ClickHouse (real analytics backbone). Local Docker by default.
  clickhouse: {
    enabled: bool(process.env.CLICKHOUSE_ENABLED, true),
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    user: process.env.CLICKHOUSE_USER ?? "default",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    database: process.env.CLICKHOUSE_DATABASE ?? "sauron",
    // ClickHouse Cloud service id, for console deep links to each run's query.
    serviceId: process.env.CLICKHOUSE_SERVICE_ID ?? "",
  },

  // Semgrep (code security). If the CLI is absent we skip, never crash.
  semgrep: {
    enabled: bool(process.env.SEMGREP_ENABLED, true),
    rules: process.env.SEMGREP_RULES ?? "semgrep/mcp-rules.yaml",
    // Source we scan for the demo: the canary's own code.
    canarySource: process.env.SEMGREP_CANARY_SRC ?? "canary",
  },

  // Palantir = Senso verified-context store. Real when a key is set.
  senso: {
    enabled: bool(process.env.SENSO_ENABLED, !!process.env.SENSO_API_KEY),
    apiKey: process.env.SENSO_API_KEY ?? "",
    baseUrl: process.env.SENSO_BASE_URL ?? "https://apiv2.senso.ai/api/v1",
    folderId: process.env.SENSO_FOLDER_ID ?? "",
  },

  // Black Gate = Guild hosting + allowlist/gateway. Real when a key is set.
  guild: {
    enabled: bool(process.env.GUILD_ENABLED, !!process.env.GUILD_API_KEY),
    apiKey: process.env.GUILD_API_KEY ?? "",
    baseUrl: process.env.GUILD_BASE_URL ?? "https://api.guild.ai/v1",
    workspace: process.env.GUILD_WORKSPACE ?? "",
    agentId: process.env.GUILD_AGENT_ID ?? "",
  },

  // Akash inference (AkashML, OpenAI-compatible) for triage summaries.
  akash: {
    enabled: bool(process.env.AKASH_ENABLED, !!process.env.AKASHML_API_KEY),
    apiKey: process.env.AKASHML_API_KEY ?? "",
    baseUrl: process.env.AKASHML_BASE_URL ?? "https://api.akashml.com/v1",
    model: process.env.AKASHML_MODEL ?? "meta-llama/Llama-3.3-70B-Instruct",
  },
};

export type Config = typeof config;
