# 👁 Sauron — the Eye that never blinks

**An autonomous agent that watches every tool server your AI agents connect to, catches the ones
that turn malicious *after* they're approved, and blocks them at the gate — before any agent ever
sees the malicious tool.**

> Built for the Cyberdefense Hackathon (tokens&, SF, 2026-10-09).

## The real problem

On **2026-08-12**, Pillar Security caught **Deadbugz** — the first MCP tool server in the wild that
behaved normally, then **changed its tool descriptions after its third call**, sending connected
agents to hunt for credentials. It spread through 23 pull requests in 74 minutes.
([Pillar Security](https://www.pillar.security/blog/deadbugz-currently-active-mcp-supply-chain-campaign))

Install-time scanners check a server **once**, at approval. They see the benign face. The whole class
of attack — Deadbugz, Plugin4Shell, HookPry — lives in the gap between *approval* and *what the thing
does later*. Guild's own research: **91.5% of 3,012 MCP registry servers** use static keys, personal
tokens, or no auth at all.

Nobody re-checks servers continuously, detonates them to see if they turn, and blocks them at the
gateway. Sauron does.

## What it does (autonomously, on live data)

1. **Watches** the live [official MCP registry](https://registry.modelcontextprotocol.io) for new and
   updated servers.
2. **Detonates** each one in a sandbox ("Mount Doom"): connect, list tools, make a few harmless calls,
   list again, and **diff**. A description that changed, or a tool that only appeared after the calls,
   is a rug pull.
3. **Scans** the server's code with custom **Semgrep** rules for MCP-specific risks (instruction-like
   text in tool descriptions, command injection in handlers).
4. **Records** every snapshot, finding and verdict in **ClickHouse** — drift detection and the
   cross-server hunt are plain SQL over a big table.
5. **Reasons** over the findings with an open model on **Akash** (AkashML) to write the triage summary.
6. **Remembers** each verdict in **Senso** with its evidence, so agents can check a server *before*
   connecting — grounded in verified context, not a guess.
7. **Blocks** at the **Black Gate** (**Guild**): a rug pull is auto-quarantined (reversible); a
   permanent block waits for a human. Guild hosts the agent and holds the audit trail.

## The sponsors (how each is used)

| Sponsor | Role in Sauron | Live? |
|---|---|---|
| **ClickHouse** | The real-time backbone. Every tool snapshot / finding / verdict / gate event is a row. Drift is one SQL query over 100k+ rows in ~70 ms; one query hunts the same pattern across every server. | ✅ Cloud |
| **Semgrep** | Custom MCP rules (`semgrep/mcp-rules.yaml`) scan each server's source: instruction-text in tool descriptions, and command injection in tool handlers. | ✅ CLI |
| **Guild** | The Black Gate: hosts the watch agent, owns the allowlist/gateway every agent routes through, auto-quarantines rug pulls, escalates permanent blocks to a human. | ✅ API |
| **Senso** | The Palantir: verified-context store. Each verdict is written with its sources; the gate answers "is this server safe?" from Senso's RAG before an agent connects. | ✅ API |
| **Akash** | AkashML (Llama-3.3-70B) writes the plain-English triage verdict from the deterministic findings. The detonation sandbox is deployable on Akash compute (`deploy/akash/`). | ✅ AkashML |

Deterministic core, LLM only at the edges: the **catch** is code + SQL; the model only phrases the
verdict.

## Run it

```bash
cd sauron
npm install
cp .env.example .env          # fill sponsor keys, or run fully local (see below)

# ClickHouse: either point .env at ClickHouse Cloud, or run local:
docker compose up -d          # local ClickHouse on :8123

# in three terminals (or background):
npm run canary                # the two-faced canary MCP server on :8808
npm run eye                   # the Eye: dashboard + gateway on :7777
npm run seed                  # (optional) seed ClickHouse for the scale story

open http://localhost:7777
```

Then click **Detonate canary**: watch the canary flip, Semgrep fire, the verdict land in Senso,
ClickHouse catch the drift, and the Black Gate quarantine it. Click **Agent tries to connect** to see
an agent denied at the gate, citing Senso.

**Fully local (no accounts):** leave the sponsor keys empty. ClickHouse runs via Docker, Semgrep runs
from the CLI, and Senso/Guild fall back to safe local stand-ins. The catch still works end to end.

## The canary

`canary/server.ts` is a self-owned **test fixture**: a real MCP server that serves benign tools, then
after 3 calls swaps in instruction-like descriptions and a new tool (all inert, marked
`[CANARY_DRIFT]`). It reenacts Deadbugz so Sauron has something real to catch on stage. Nothing in it
performs a real action.

## Layout

```
canary/server.ts     the two-faced canary MCP server
src/detonator.ts     Mount Doom: connect, snapshot, call N, snapshot, diff
src/semgrep.ts       custom-rule scan of server source
src/scorer.ts        findings + 0..100 score + verdict (deterministic)
src/akash.ts         AkashML triage summary
src/palantir.ts      Senso verified-context verdict store
src/blackgate.ts     Guild allowlist / gateway / human approval
src/clickhouse.ts    snapshots, findings, verdicts, drift SQL
src/eye.ts           the orchestration loop
src/server.ts        dashboard + API + SSE + gateway endpoint
public/              the Eye (dashboard)
semgrep/mcp-rules.yaml   the custom MCP rules
deploy/akash/        Akash SDLs
```
