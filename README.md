# PZ Discord Bot

Zero-cost Project Zomboid server status monitor for a private Discord.

## Goal

Keep one neat Discord status message up to date without running a paid VPS or leaving a home PC online.

```text
HostHavoc Project Zomboid
        |
        | UDP server query
        v
GitHub Actions monitor (every 5 minutes)
        |
        | HTTPS /ingest
        v
Cloudflare Worker + D1
        |
        +--> edits one permanent Discord status message
        +--> handles Discord buttons / subscriptions
```

## V1 features

- Online / offline state based on an actual Project Zomboid query, not the HostHavoc process badge.
- Player count, max players, ping, build/version and player names when the query exposes them.
- One permanent Discord status card that is edited in place.
- One private per-user control panel, avoiding channel spam.
- Live Refresh button that dispatches a fresh GitHub Actions probe, protected by a 30-second global cooldown.
- Current players, join instructions and notification subscription controls.
- D1 storage for the latest status, the permanent Discord message ID, refresh cooldown state and notification subscriptions.
- No recurring hosting cost when kept inside GitHub Actions + Cloudflare free tiers.

## Repository layout

```text
apps/
  monitor/              Node/TypeScript GameDig probe run by GitHub Actions
  worker/               Cloudflare Worker: Discord + status API + D1
packages/
  shared/               Shared status contracts
.github/workflows/
  poll-server.yml       Scheduled server probe
  typecheck.yml         Basic CI
```

## Setup overview

### 1. Cloudflare

Create a Worker and a D1 database, then update `apps/worker/wrangler.jsonc` with the real D1 database id.

Run the SQL in `apps/worker/schema.sql` against the D1 database.

Configure these Worker secrets/variables:

- `DISCORD_BOT_TOKEN` - Discord **bot token**. Never commit it.
- `DISCORD_PUBLIC_KEY` - Discord application's public key used to verify interactions.
- `DISCORD_CHANNEL_ID` - channel containing the permanent server-status message.
- `MONITOR_API_KEY` - random shared secret accepted by `/ingest`.
- `GITHUB_ACTIONS_TOKEN` - fine-grained GitHub token restricted to this repository with Actions read/write permission; used only by the live Refresh button.
- `JOIN_TEXT` - optional join instructions shown by the button.

Deploy the Worker and set its `/discord/interactions` URL as the Discord application's Interactions Endpoint URL.

> If an old Discord bot token has ever appeared in a screenshot, chat log or committed config, rotate it before using this project.

### 2. GitHub Actions secrets

In repository **Settings -> Secrets and variables -> Actions**, add:

- `PZ_HOST` - HostHavoc game-server host/IP.
- `PZ_PORT` - Project Zomboid game/query port.
- `WORKER_INGEST_URL` - for example `https://your-worker.workers.dev/ingest`.
- `MONITOR_API_KEY` - same random value configured in the Worker.

The scheduled workflow runs every five minutes (offset from the top of the hour). You can also run it manually from the Actions tab, and the Discord Refresh button dispatches it on demand.

### 3. Discord application

The bot needs access to the configured status channel and permission to:

- View Channel
- Send Messages
- Read Message History

The Worker automatically creates the permanent status message on the first successful monitor ingest, then edits that same message on later checks.

## Local development

Requirements: Node.js 22+.

```bash
npm install
npm run typecheck
```

Run one local monitor probe:

```bash
PZ_HOST=127.0.0.1 \
PZ_PORT=16261 \
WORKER_INGEST_URL=http://localhost:8787/ingest \
MONITOR_API_KEY=dev-secret \
npm run monitor
```

Run the Worker locally:

```bash
npm run dev:worker
```

## Design notes

The monitoring component intentionally runs separately from Project Zomboid. If PZ becomes unhealthy while the HostHavoc process remains alive, the GameDig probe can still report the server as unavailable. The Discord component remains independent and can continue displaying the last successful check.

The first version does **not** use RCON. RCON can be added later for guaranteed player lists, one-minute Worker-side checks and admin-only actions, but read-only GameDig monitoring keeps the initial deployment much safer.

## Planned follow-ups

- Optional RCON player-list probe.
- One-minute Worker-side monitoring once RCON/TCP health is verified.
- Notifications when the server reaches N players.
- Scheduled restart notices.
- Modpack/build version shown in Discord.
- Health history and uptime metrics.
