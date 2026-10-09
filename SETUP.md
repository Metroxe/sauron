# Sauron — sponsor account setup

The build runs locally with none of these. Do them to light up the real portals in the demo.
Paste each value into `sauron/.env` (copy from `.env.example`). Scan the credit QRs from the
printed slides in `materials/slides/`.

## 1. ClickHouse Cloud (for the real-time analytics portal)

1. On your phone, scan the QR on `materials/slides/09-clickhouse-credits-qr.jpg` ($400 credits).
2. Sign up with a **NEW email** (the slide says returning accounts must use a fresh one).
3. Click **"New service"**. Pick any region. Name it `sauron`.
4. When it's ready, open the service and click **"Connect"** (top right).
5. Copy the **HTTPS endpoint** (looks like `https://xxxx.clickhouse.cloud:8443`) and the
   **password** shown.
6. In `.env` set: `CLICKHOUSE_URL=<https endpoint>`, `CLICKHOUSE_PASSWORD=<password>`,
   `CLICKHOUSE_USER=default`.

## 2. AkashML + Akash Console (open-model inference + deploy)

1. Go to `https://akashml.com`. Click **"Sign in"** (top right), sign up.
2. Open **"API Keys"** in the left sidebar. Click **"Create API Key"**. Copy it.
3. In `.env` set: `AKASHML_API_KEY=<key>`.
4. For deploying the sandbox on Akash: go to `https://console.akash.network`, sign in.
5. Open **Billing / Add funds** and enter the promo code **`AKASHCYBER25`** ($25 credit).

## 3. Guild (agent hosting + the gateway / allowlist = the Black Gate)

1. Go to `https://guild.ai`. Click **"Sign in"** / **"Get started"**, sign up.
2. Find **Settings → API keys** (or developer settings). Create a key, copy it.
3. Note your **workspace** name/slug (top-left switcher).
4. In `.env` set: `GUILD_API_KEY=<key>`, `GUILD_WORKSPACE=<workspace>`.

## 4. Senso (verified-context store = the Palantir)

1. Go to `https://docs.senso.ai/sign-up`. Create an account and an **organization**.
2. Open **API keys** (docs.senso.ai → API keys). Create one, copy it.
3. Create a folder for this event: either in the UI, or after install run
   `npx -y @senso-ai/cli kb create-folder --name "Sauron"` and copy the printed `kb_node_id`.
4. In `.env` set: `SENSO_API_KEY=<key>`, `SENSO_FOLDER_ID=<kb_node_id>`.
   Use a fresh org/folder so search stays scoped to this project.

## 5. Semgrep (code security)

- Nothing needed from you for our custom rules. I install the `semgrep` CLI myself.
- Optional (Semgrep's "Good" tier): install the Guardian plugin in Claude Code with
  `claude plugin install semgrep@claude-plugins-official` and sign in. Your call; I won't
  install it unless you say so.

## After you've filled .env

Tell me, or just run:

```bash
cd sauron && cp .env.example .env   # then paste your keys into .env
```

I'll wire the real portals and re-test. Until then everything uses local Docker ClickHouse and
local stand-ins for Senso/Guild, so the demo still works end to end.
