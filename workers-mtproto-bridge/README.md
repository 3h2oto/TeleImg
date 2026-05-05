# Workers MTProto Bridge

A **Cloudflare Workers Free plan** compatible MTProto bridge for TeleImg.

## What it uses

- Workers HTTP entrypoint
- 1 SQLite-backed Durable Object
- Outbound TCP sockets (`cloudflare:sockets`)
- A short-lived signed download URL
- A GramJS `StringSession` stored as a Worker secret / env var

## What it does not use

- Spectrum
- Containers
- Inbound TCP
- VPS-only local disk state

## Required secrets / env vars

- `TG_MT_BRIDGE_SECRET`
- `TG_USER_API_ID`
- `TG_USER_API_HASH`
- `TG_MT_STRING_SESSION`
- optional: `TG_MT_DIALOG_SCAN_LIMIT`

## Generate the GramJS string session

```bash
TG_USER_API_ID=123456 \
TG_USER_API_HASH=your_hash \
node tools/login.mjs
```

Save the printed `TG_MT_STRING_SESSION=...` value and set it as a Worker secret.

## Local dev

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev
```

## Validate bundle

```bash
npm run check
npm run deploy -- --dry-run
```

## Deploy

```bash
wrangler secret put TG_MT_BRIDGE_SECRET
wrangler secret put TG_USER_API_HASH
wrangler secret put TG_MT_STRING_SESSION
wrangler deploy
```

For `TG_USER_API_ID`, a plain env var is fine because it is not secret.

## Current state

This project already:

- verifies signed download URLs at the Worker edge
- forwards authorized requests into a Durable Object
- creates a GramJS client inside the Durable Object
- uses outbound TCP sockets so it stays compatible with Workers Free plan
- supports `HEAD` and single `Range: bytes=...` requests for resumable media access
- streams `/healthz` correctly in local Wrangler dev
- bundles successfully with `wrangler deploy --dry-run`

End-to-end Telegram media download still depends on a real Telegram user session and real production secrets.
