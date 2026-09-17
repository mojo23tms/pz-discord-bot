# Architecture

## Objectives

1. Cost $0/month beyond the existing Project Zomboid host.
2. Stay available even when the game process is unhealthy.
3. Check actual PZ query health rather than trusting a hosting-panel process badge.
4. Keep Discord UX clean: one status card, buttons, no periodic message spam.
5. Keep destructive/admin functionality out of V1.
6. Never store secrets in git.

## Components

### Monitor — GitHub Actions

A scheduled Node/TypeScript job runs every five minutes and performs a GameDig `projectzomboid` query against the HostHavoc endpoint. It normalizes the result to the shared `ServerStatus` contract and POSTs it to the Worker.

GameDig is intentionally outside Cloudflare Workers because the PZ query protocol uses UDP, while the Worker is used for HTTPS/Discord interactions.

A query is attempted twice before the sample is reported as offline. Future versions can add multi-sample/degraded-state logic to avoid declaring an outage on a transient UDP loss.

### API/UI — Cloudflare Worker

The Worker exposes three routes:

- `GET /health` — Worker health only.
- `POST /ingest` — authenticated monitor status input.
- `POST /discord/interactions` — Discord interaction endpoint with Ed25519 signature verification.

On each ingest it stores the latest status in D1 and creates or edits one permanent Discord message.

### State — Cloudflare D1

The V1 schema contains:

- `server_status` — one latest normalized server status.
- `settings` — persistent IDs such as the Discord status-message ID.
- `subscriptions` — Discord users who want online/offline transition notifications.

## Discord controls

`Refresh` returns the newest cached probe and its age. It does not currently perform a direct UDP query because the Worker cannot do that. A later version can dispatch the GitHub Actions workflow for true on-demand probing.

`Players` returns names when the PZ query exposes them. A non-empty player count with an empty name list is treated as valid because server query responses may omit names.

`How to join` returns the configured `JOIN_TEXT` privately to the clicking user.

`Notify me` toggles a D1 subscription. Subscribers are mentioned only when the stored state transitions between online and offline.

## Security model

- `MONITOR_API_KEY` protects `/ingest`.
- Discord interactions are verified with the application's public key.
- Discord REST calls use a bot token stored only as a Cloudflare secret.
- Discord messages disable accidental mention parsing except for deliberate subscriber mentions.
- No RCON credentials exist in V1.
- Join instructions must never contain account/admin/RCON passwords.

## Future server-management layer

RCON can later be added as a separate probe/service for authoritative player lists, announcements and tightly controlled admin actions. Destructive actions should require a Discord role allowlist and confirmation. RCON alone cannot revive a stopped HostHavoc process, so host-level restart controls require a separately documented hosting-provider API or manual panel action.

## Reliability roadmap

V1 is deliberately small. Recommended next reliability changes:

1. Three-failure outage threshold stored in D1.
2. Distinct `online`, `degraded`, and `offline` presentation.
3. Detect stale monitoring when GitHub Actions has not reported within an expected interval.
4. Keep a short sample history for uptime graphs.
5. Add a modpack/build identifier supplied from the managed server configuration repository.
6. Optional RCON probe as a second signal independent of the GameDig query.
