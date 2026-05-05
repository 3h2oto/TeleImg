# TeleImg

TeleImg is now an **Astro + Cloudflare Pages** project that keeps the original Cloudflare Pages Functions routes for upload, file proxying, and dashboard management.

## What changed

- Replaced the legacy static / Nuxt bundle with an Astro-based frontend.
- Kept compatibility with the original public routes:
  - `/`
  - `/index-md.html`
  - `/admin`
  - `/admin.html`
  - `/admin-imgtc.html`
  - `/admin-waterfall.html`
  - `/upload`
  - `/file/:id`
  - `/api/manage/*`
- Removed the fragile Sentry telemetry middleware that could break requests.
- Fixed the rename endpoint to read `?newName=` correctly.
- Added automated tests for list / rename / like / file access / upload validation.

## Stack

- Astro 6
- Cloudflare Pages Functions
- Wrangler 4
- Vitest

## Local development

### 1. Install

```bash
npm install
```

### 2. Prepare env vars

Copy the template and fill in your real values:

```bash
cp .dev.vars.example .dev.vars
```

Required variables:

- `TG_Bot_Token`
- `TG_Chat_ID`

Optional variables:

- `BASIC_USER`
- `BASIC_PASS`
- `ModerateContentApiKey`
- `WhiteList_Mode`
- `TG_WEBHOOK_SECRET`
- `TG_MT_BRIDGE_URL`
- `TG_MT_BRIDGE_SECRET`

### 3. Start Astro-only dev server

```bash
npm run dev
```

### 4. Start full Pages runtime locally

```bash
npm run build
wrangler pages dev dist
```

This mode loads Pages Functions, KV bindings, and `.dev.vars`.

## Testing

```bash
npm run check
npm test
npm run build
```

## Cloudflare Pages deployment

### Build settings

- Build command: `npm run build`
- Output directory: `dist`

### Bindings

Create a KV namespace and bind it as:

- `img_url`

### Environment variables

Set the same variables you use locally inside the Pages dashboard.

## Reusing an existing Pages project

If you already have a deployed Pages project, you can reuse its settings locally:

```bash
wrangler pages download config <project-name>
```

Then move secrets into a local `.dev.vars` file instead of committing them.

## CI

GitHub Actions runs:

- `npm ci`
- `npm run check`
- `npm test`
- `npm run build`

## Telegram direct uploads

To capture media uploaded directly inside Telegram (instead of through the web uploader), deploy the project and then configure the webhook from `/admin`.

Important limitation:

- For **groups / supergroups**, the bot must have Telegram privacy mode disabled via **BotFather -> /setprivacy -> Disable**; otherwise Telegram will not send ordinary user media messages to the bot.
- For **channels**, the bot must be an admin so it can receive `channel_post` updates and delete messages later.
- Old historical messages that were never seen by the bot cannot be reconstructed from Telegram full history through the Bot API.

## MTProto fallback for oversized Telegram files

Telegram Bot API may reject large media with `Bad Request: file is too big`. This project now supports an optional **Rust MTProto bridge** so `/file/:id` can redirect oversized Telegram-app uploads to a signed user-session download path.

### What runs where

- **Cloudflare Pages** keeps handling normal uploads, admin, signing, and Bot API file delivery.
- A separate **Rust MTProto bridge** on your VPS validates the short-lived signature and downloads the file through a Telegram **user session**.

This split is deliberate: the public bridge stays small and auditable, while the Telegram user session stays off Cloudflare Pages.

### 1. Create a Telegram user session file

First create your own Telegram API credentials at `https://my.telegram.org`, then run:

```bash
cargo run --manifest-path mtproto-bridge-rs/Cargo.toml --bin teleimg-mtproto-login -- \
  --api-id 123456 \
  --api-hash your_hash \
  --session-file ./teleimg-user.session
```

You can also use the npm wrapper:

```bash
TG_USER_API_ID=123456 \
TG_USER_API_HASH=your_hash \
TG_USER_SESSION_FILE=./teleimg-user.session \
npm run mtproto:login
```

This creates a persistent SQLite session file such as `teleimg-user.session`. Do **not** commit it.

### 2. Install and run the Rust bridge on your VPS

Install the release binary onto the VPS:

```bash
cargo install --path mtproto-bridge-rs --root /usr/local
```

Run it directly:

```bash
TG_MT_BRIDGE_BIND=127.0.0.1:8788 \
TG_MT_BRIDGE_SECRET=replace_with_long_random_secret \
TG_USER_API_ID=123456 \
TG_USER_SESSION_FILE=/var/lib/teleimg/teleimg-user.session \
/usr/local/bin/teleimg-mtproto-bridge
```

Health check:

```bash
curl http://127.0.0.1:8788/healthz
```

Important note:

- The bridge only needs `TG_USER_API_ID`, the SQLite `TG_USER_SESSION_FILE`, and `TG_MT_BRIDGE_SECRET` at runtime.
- `TG_USER_API_HASH` is only needed during the login/bootstrap step.
- The secure default bind is `127.0.0.1`; put it behind Caddy or Nginx for public HTTPS exposure.

### 3. Reverse proxy it publicly

Example files are included:

- `ops/systemd/teleimg-mtproto-bridge.service.example`
- `ops/systemd/mtproto-bridge.env.example`
- `ops/caddy/teleimg-mtproto-bridge.Caddyfile.example`

A typical deployment is:

1. copy `teleimg-mtproto-bridge` to `/usr/local/bin/`
2. store the session file under `/var/lib/teleimg/`
3. store env vars in `/etc/teleimg/mtproto-bridge.env`
4. run the systemd unit
5. terminate TLS at Caddy/Nginx and proxy to `127.0.0.1:8788`

### 4. Point Pages to the bridge

Set these two variables in Cloudflare Pages:

- `TG_MT_BRIDGE_URL=https://your-bridge.example.com`
- `TG_MT_BRIDGE_SECRET=replace_with_long_random_secret`

When Bot API `getFile` works, TeleImg still uses the normal bot file path.
When Bot API says `file is too big`, TeleImg now issues a short-lived signed redirect to the Rust bridge.

## Workers Free plan MTProto bridge (experimental)

If you want to avoid any VPS-only paid features and stay inside **Workers Free plan** capabilities, this repo now also contains a separate subproject:

- `workers-mtproto-bridge/`

It is designed around:

- Worker HTTP entrypoint
- one SQLite-backed Durable Object
- outbound TCP sockets
- a GramJS `StringSession` secret

Quick commands:

```bash
npm run mtproto:worker:check
npm run mtproto:worker:dev
npm run mtproto:worker:deploy -- --dry-run
```

Read `workers-mtproto-bridge/README.md` before deploying it.
