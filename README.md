# PZ Discord Bot

Zero-cost Project Zomboid server status monitor for a private Discord.

## Goal

Keep one neat Discord status message up to date without running a paid VPS or leaving a home PC online.

```text
HostHavoc Project Zomboid
        |
        | UDP server query
        v
GitHub Actions monitor (scheduled + on-demand)
        |
        | HTTPS /ingest
        v
Cloudflare Worker + D1
        |
        +--> edits one permanent Discord status message
        +--> handles Discord controls / subscriptions
        +--> dispatches an immediate GitHub probe when Refresh is pressed
```

## V1 features

- Online / offline state based on an actual Project Zomboid query, not the HostHavoc process badge.
- Player count, max players, ping and player names when the query exposes them.
- One permanent Discord status card that is edited in place.
- One per-user ephemeral control panel, so button use does not flood the public channel.
- `Refresh` dispatches a fresh GitHub Actions probe instead of only re-reading cached status.
- Global 30-second refresh cooldown to prevent button spam from launching many workflows.
- Current players, join instructions and per-user online/offline notification subscription.
- D1 storage for latest status, the permanent Discord message ID, refresh cooldown state and subscriptions.
- No recurring hosting cost when kept inside GitHub Actions + Cloudflare free tiers.

## Repository layout

```text
apps/
  monitor/              Node/TypeScript GameDig probe run by GitHub Actions
  worker/               Cloudflare Worker: Discord + status API + D1
packages/
  shared/               Shared status contracts
.github/workflows/
  poll-server.yml       Scheduled and workflow_dispatch server probe
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
- `GITHUB_ACTIONS_TOKEN` - fine-grained GitHub token restricted to this repository with **Actions: Read and write**; used only to dispatch the server-poll workflow when a Discord user presses Refresh.
- `JOIN_TEXT` - optional join instructions shown by the button.

Deploy the Worker and set its `/discord/interactions` URL as the Discord application's Interactions Endpoint URL.

> If an old Discord bot token has ever appeared in a screenshot, chat log or committed config, rotate it before using this project. Never commit `GITHUB_ACTIONS_TOKEN` either.

### 2. GitHub Actions secrets

In repository **Settings -> Secrets and variables -> Actions**, add:

- `PZ_HOST` - HostHavoc game-server host/IP.
- `PZ_PORT` - Project Zomboid game/query port.
- `WORKER_INGEST_URL` - for example `https://your-worker.workers.dev/ingest`.
- `MONITOR_API_KEY` - same random value configured in the Worker.

The scheduled workflow runs every five minutes. It can also be started immediately through `workflow_dispatch`; the Discord Refresh control uses that path.

### 3. Discord application

The bot needs access to the configured status channel and permission to:

- View Channel
- Send Messages
- Embed Links
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

The current version does **not** use RCON. RCON can be added later for guaranteed player lists, true direct refreshes and admin-only actions, but read-only GameDig monitoring keeps the initial deployment much safer.

A Discord Refresh does not query UDP directly from Cloudflare. It dispatches `poll-server.yml`, which starts a GitHub-hosted GameDig probe and publishes the fresh result back to the Worker. The public Discord card is then updated automatically. The control panel tells the user that the refresh was requested and rate-limits new refresh requests for 30 seconds.

## Planned follow-ups

- Optional RCON player-list probe and direct refresh.
- One-minute monitoring through a non-GitHub-schedule path.
- Notifications when the server reaches N players.
- Scheduled restart notices.
- Modpack/build version shown from a reliable source.
- Health history and uptime metrics.
- Automatic Worker deployment from GitHub.
