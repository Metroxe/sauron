# Real sources shown in the demo

Open the demo on the ACTUAL incident, not a claim. Primary:

- **Deadbugz — first in-the-wild MCP rug pull** (Pillar Security, 2026-08-12). The server behaves
  normally, then changes its tool descriptions after the **3rd tool call**; spread via 23 PRs in 74
  minutes. This is exactly what Sauron's canary reenacts and catches.
  https://www.pillar.security/blog/deadbugz-currently-active-mcp-supply-chain-campaign

Secondary (optional, if asked "is this a one-off?"):
- **Plugin4Shell** — plugin pins not enforced by Claude Code / Codex / Copilot / Gemini CLI
  (air.security, 2026-09-17). https://www.air.security/blog-posts/plugin4shell
- **HookPry** — plugin updates that add lifecycle hooks, up to 92.5% success, Defender 0%
  (arXiv 2609.03884, 2026-09-03). https://arxiv.org/abs/2609.03884
- **Guild's own data** — "91.5% of 3,012 MCP registry servers" use static keys, personal tokens or
  no auth (Cory Waddingham, Guild, 2026-07-22).
  https://www.guild.ai/blog/agent-governance/your-authorization-platform-doesnt-govern-your-age

TODO before recording: screenshot the Deadbugz article (the "after three tool calls" paragraph) into
this folder as `deadbugz.png` so the open never depends on the live page loading.
