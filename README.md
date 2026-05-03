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
