# PZ Discord Bot

Zero-cost Project Zomboid server status monitor for a private Discord.

## Goal

Keep one neat Discord status message up to date without running a paid VPS or leaving a home PC online.

```text
HostHavoc Project Zomboid
        ^
        | Source RCON over TCP
        |
Cloudflare Worker + D1
        |
        +--> Cron probe every minute
        +--> live Discord Refresh
        +--> edits one permanent Discord status message
        +--> handles Discord buttons / subscriptions

GitHub Actions + GameDig
        |
        +--> manual/fallback game-endpoint probe only
```

## Current features

- Online / offline state based on direct Project Zomboid RCON reachability.
- Player count and player names from the native `players` RCON command.
- Max players and public server name parsed from `showoptions` without storing the raw options output.
- One-minute Cloudflare Cron monitoring.
- One permanent Discord status card that is edited in place.
- Explicit `Last checked` relative time instead of an ambiguous embed timestamp.
- One private per-user control panel, avoiding channel spam.
- Live Refresh performs a direct RCON probe instead of waiting for a GitHub runner.
- Ten-second global Refresh cooldown.
- Current players, join instructions and notification subscription controls.
- D1 storage for latest status, status-message ID, refresh cooldown and subscriptions.
- GitHub GameDig workflow retained as a manual fallback and as a double-check when an on-demand RCON probe fails.
- `/server` interaction handling is implemented in the Worker; the Discord slash command still needs to be registered with the application before it appears in the client.
- No recurring hosting cost when kept within Cloudflare/GitHub free allowances.

## Repository layout

```text
apps/
  monitor/              Node/TypeScript GameDig fallback probe
  worker/               Cloudflare Worker: Discord + RCON + D1
    src/rcon.ts          Minimal Source RCON client using Cloudflare TCP sockets
packages/
  shared/               Shared status contracts
.github/workflows/
  poll-server.yml       Manual GameDig fallback
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
- `MONITOR_API_KEY` - random shared secret accepted by `/ingest` for the GitHub fallback monitor.
- `GITHUB_ACTIONS_TOKEN` - fine-grained GitHub token restricted to this repository with Actions read/write permission; used only to launch the GameDig fallback.
- `RCON_HOST` - public hostname/IP of the Project Zomboid RCON endpoint.
- `RCON_PORT` - Project Zomboid RCON TCP port.
- `RCON_PASSWORD` - strong dedicated RCON password. Never reuse the Discord bot token, join password or an account password.
- `JOIN_TEXT` - optional join instructions shown by the button.

`wrangler.jsonc` configures a `* * * * *` Cron Trigger, so the Worker runs the RCON health probe once per minute after deployment.

Deploy the Worker and set its `/discord/interactions` URL as the Discord application's Interactions Endpoint URL.

> If an old Discord bot token has ever appeared in a screenshot, chat log or committed config, rotate it before using this project.

### 2. GitHub Actions secrets

The GitHub GameDig monitor is now fallback-only. Keep these repository Actions secrets so it can still be launched manually or after an RCON failure:

- `PZ_HOST` - HostHavoc game-server host/IP.
- `PZ_PORT` - Project Zomboid game/query port.
- `WORKER_INGEST_URL` - for example `https://your-worker.workers.dev/ingest`.
- `MONITOR_API_KEY` - same random value configured in the Worker.

### 3. Discord application

The bot needs access to the configured status channel and permission to:

- View Channel
- Send Messages
- Embed Links
- Read Message History

The Worker automatically creates the permanent status message on the first successful status update and edits that same message later. If the message is deleted, the next successful sync recreates it as long as the bot still has the permissions above.

## Local development

Requirements: Node.js 22+.

```bash
npm install
npm run typecheck
```

Run the Worker locally:

```bash
npm run dev:worker
```

Cloudflare exposes the local scheduled-handler route through Wrangler, so a Cron probe can be simulated with:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

The old GameDig monitor can still be run manually as a fallback:

```bash
PZ_HOST=127.0.0.1 \
PZ_PORT=16261 \
WORKER_INGEST_URL=http://localhost:8787/ingest \
MONITOR_API_KEY=dev-secret \
npm run monitor
```

## Design notes

The Discord/monitoring component remains separate from the game process, so it can report that Project Zomboid is unavailable even when the hosting control panel still says the process is running.

The Worker uses Cloudflare's outbound TCP `connect()` API to speak the native Source RCON wire protocol directly. Only read-only `players` and `showoptions` commands are issued by the monitoring path. Administrative RCON actions are intentionally not exposed through Discord yet.

The `showoptions` response is parsed in memory only for `MaxPlayers` and `PublicName`; its raw contents are never stored or sent to Discord.

## Planned follow-ups

- Register the `/server` slash command as a permanent recovery/control entry point.
- Require two consecutive failed probes before sending an offline notification, to reduce false alarms.
- Notifications when the server reaches N players.
- Scheduled restart notices.
- Modpack/build version shown in Discord.
- Health history and uptime metrics.
- Carefully scoped admin-only RCON actions with role checks and confirmation prompts.
