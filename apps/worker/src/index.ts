import nacl from 'tweetnacl';
import type { ServerStatus } from '@pz-discord/shared';

interface Env {
  DB: D1Database;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_CHANNEL_ID: string;
  MONITOR_API_KEY: string;
  GITHUB_ACTIONS_TOKEN: string;
  JOIN_TEXT?: string;
}

interface DiscordInteraction {
  type: number;
  data?: { custom_id?: string };
  member?: { user?: { id?: string } };
  user?: { id?: string };
}

type PanelView = 'overview' | 'players' | 'join';

type RefreshDispatchResult =
  | { triggered: true }
  | { triggered: false; retryAfterSeconds: number };

const DISCORD_API = 'https://discord.com/api/v10';
const GITHUB_API = 'https://api.github.com';
const GITHUB_REPOSITORY = 'mojo23tms/pz-discord-bot';
const GITHUB_WORKFLOW = 'poll-server.yml';
const GITHUB_REF = 'main';
const REFRESH_COOLDOWN_MS = 30_000;
const REFRESH_SETTING_KEY = 'refresh_last_requested_at';
const EPHEMERAL = 1 << 6;

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function verifyDiscordRequest(request: Request, rawBody: string, publicKey: string): boolean {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return false;

  const message = new TextEncoder().encode(timestamp + rawBody);
  return nacl.sign.detached.verify(message, hexToBytes(signature), hexToBytes(publicKey));
}

function parseStatus(value: unknown): ServerStatus {
  const status = value as Partial<ServerStatus>;
  if (!status || (status.health !== 'online' && status.health !== 'offline')) {
    throw new Error('Invalid health value');
  }
  if (!status.checkedAt || !status.host || !Number.isFinite(status.port)) {
    throw new Error('Invalid status payload');
  }

  return {
    health: status.health,
    checkedAt: status.checkedAt,
    name: status.name,
    host: status.host,
    port: Number(status.port),
    players: Number(status.players ?? 0),
    maxPlayers: Number(status.maxPlayers ?? 0),
    playerNames: Array.isArray(status.playerNames) ? status.playerNames.filter((v): v is string => typeof v === 'string') : [],
    pingMs: Number.isFinite(status.pingMs) ? Number(status.pingMs) : undefined,
    version: status.version,
    error: status.error,
  };
}

async function getLatestStatus(env: Env): Promise<ServerStatus | null> {
  const row = await env.DB.prepare('SELECT payload FROM server_status WHERE id = 1').first<{ payload: string }>();
  return row ? JSON.parse(row.payload) as ServerStatus : null;
}

async function saveLatestStatus(env: Env, status: ServerStatus): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO server_status (id, payload, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).bind(JSON.stringify(status), Date.now()).run();
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(key, value).run();
}

function statusMessage(status: ServerStatus): Record<string, unknown> {
  const isOnline = status.health === 'online';
  const players = status.maxPlayers > 0 ? `${status.players} / ${status.maxPlayers}` : String(status.players);
  const names = status.playerNames.length > 0 ? status.playerNames.slice(0, 20).join('\n') : 'Nobody online';
  const build = status.version && status.version !== '1.0.0.0' ? status.version : 'Not exposed by query';

  return {
    content: '',
    embeds: [{
      title: 'BOYS SERVER',
      description: isOnline ? '🟢 Server is responding' : '🔴 Server is unavailable',
      color: isOnline ? 0x57f287 : 0xed4245,
      fields: [
        { name: 'Players', value: players, inline: true },
        { name: 'Ping', value: status.pingMs !== undefined ? `${status.pingMs} ms` : '—', inline: true },
        { name: 'Build', value: build, inline: true },
        { name: 'Online', value: names, inline: false },
      ],
      footer: { text: status.error ? `Last probe: ${status.error.slice(0, 120)}` : 'Project Zomboid status monitor' },
      timestamp: status.checkedAt,
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 1, label: 'Server controls', custom_id: 'pz:panel', emoji: { name: '🎛️' } },
      ],
    }],
    allowed_mentions: { parse: [] },
  };
}

async function discordRequest(env: Env, path: string, init: RequestInit): Promise<Response> {
  return fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function syncStatusMessage(env: Env, status: ServerStatus): Promise<void> {
  const payload = statusMessage(status);
  const existingId = await getSetting(env, 'status_message_id');

  if (existingId) {
    const edited = await discordRequest(env, `/channels/${env.DISCORD_CHANNEL_ID}/messages/${existingId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    if (edited.ok) return;
  }

  const created = await discordRequest(env, `/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!created.ok) throw new Error(`Discord message sync failed: ${created.status} ${await created.text()}`);

  const body = await created.json() as { id: string };
  await setSetting(env, 'status_message_id', body.id);
}

async function notifyTransition(env: Env, before: ServerStatus | null, after: ServerStatus): Promise<void> {
  if (!before || before.health === after.health) return;

  const users = await env.DB.prepare('SELECT discord_user_id FROM subscriptions').all<{ discord_user_id: string }>();
  if (!users.results.length) return;

  const mentions = users.results.map((row) => `<@${row.discord_user_id}>`).join(' ');
  const text = after.health === 'online'
    ? `🟢 **Boys Server is back online.** ${mentions}`
    : `🔴 **Boys Server appears offline.** ${mentions}`;

  await discordRequest(env, `/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: text,
      allowed_mentions: { users: users.results.map((row) => row.discord_user_id) },
    }),
  });
}

function normalizeJoinText(raw: string | undefined): string {
  if (!raw?.trim()) return 'Join instructions have not been configured yet.';

  let text = raw.trim().replace(/\\n/g, '\n');
  let firstLabel = true;
  text = text.replace(/\s*(IP|Port|Server|Password):\s*/gi, (_match, label: string) => {
    const prefix = firstLabel ? '' : '\n';
    firstLabel = false;
    return `${prefix}**${label}:** `;
  });
  return text;
}

function getUserId(interaction: DiscordInteraction): string | null {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

async function isSubscribed(env: Env, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const row = await env.DB.prepare('SELECT discord_user_id FROM subscriptions WHERE discord_user_id = ?')
    .bind(userId).first<{ discord_user_id: string }>();
  return Boolean(row);
}

async function toggleSubscription(env: Env, userId: string): Promise<boolean> {
  const subscribed = await isSubscribed(env, userId);
  if (subscribed) {
    await env.DB.prepare('DELETE FROM subscriptions WHERE discord_user_id = ?').bind(userId).run();
    return false;
  }

  await env.DB.prepare('INSERT INTO subscriptions (discord_user_id, created_at) VALUES (?, ?)')
    .bind(userId, Date.now()).run();
  return true;
}

async function triggerServerRefresh(env: Env): Promise<RefreshDispatchResult> {
  const now = Date.now();
  const rawLastRequestedAt = await getSetting(env, REFRESH_SETTING_KEY);
  const lastRequestedAt = Number(rawLastRequestedAt ?? 0);

  if (Number.isFinite(lastRequestedAt) && lastRequestedAt > 0) {
    const elapsed = now - lastRequestedAt;
    if (elapsed < REFRESH_COOLDOWN_MS) {
      return {
        triggered: false,
        retryAfterSeconds: Math.max(1, Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000)),
      };
    }
  }

  const response = await fetch(
    `${GITHUB_API}/repos/${GITHUB_REPOSITORY}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'pz-discord-bot-worker',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: GITHUB_REF }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub workflow dispatch failed: ${response.status} ${body.slice(0, 300)}`);
  }

  await setSetting(env, REFRESH_SETTING_KEY, String(now));
  return { triggered: true };
}

function panelComponents(subscribed: boolean): Record<string, unknown>[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 1, label: 'Refresh', custom_id: 'pz:panel:refresh', emoji: { name: '🔄' } },
      { type: 2, style: 2, label: 'Players', custom_id: 'pz:panel:players', emoji: { name: '👥' } },
      { type: 2, style: 2, label: 'How to join', custom_id: 'pz:panel:join', emoji: { name: '🎮' } },
      {
        type: 2,
        style: subscribed ? 4 : 3,
        label: subscribed ? 'Notifications on' : 'Notify me',
        custom_id: 'pz:panel:notify',
        emoji: { name: subscribed ? '🔕' : '🔔' },
      },
    ],
  }];
}

function panelPayload(
  env: Env,
  status: ServerStatus | null,
  subscribed: boolean,
  view: PanelView,
  notice?: string,
): Record<string, unknown> {
  const isOnline = status?.health === 'online';
  const color = isOnline ? 0x57f287 : 0xed4245;
  const age = status ? Math.max(0, Math.floor((Date.now() - new Date(status.checkedAt).getTime()) / 1000)) : null;
  const playerCount = status ? `${status.players}/${status.maxPlayers || '?'}` : '—';
  const playerNames = status?.playerNames.length ? status.playerNames.map((name) => `• ${name}`).join('\n') : 'Nobody online';

  let title = 'BOYS SERVER • Controls';
  let description = status
    ? `${isOnline ? '🟢' : '🔴'} **${status.health.toUpperCase()}** • ${playerCount} players • checked ${age}s ago`
    : '⚪ No server probe has completed yet.';
  let fields: Record<string, unknown>[] = [
    { name: 'Notifications', value: subscribed ? '🔔 Enabled' : '🔕 Disabled', inline: true },
  ];

  if (view === 'players') {
    title = 'BOYS SERVER • Players';
    description = !status || !isOnline
      ? '🔴 Server is currently unavailable.'
      : `**Online (${status.players})**\n${playerNames}`;
    fields = [{ name: 'Notifications', value: subscribed ? '🔔 Enabled' : '🔕 Disabled', inline: true }];
  } else if (view === 'join') {
    title = 'BOYS SERVER • How to join';
    description = normalizeJoinText(env.JOIN_TEXT);
    fields = [
      { name: 'Current status', value: status ? `${isOnline ? '🟢 Online' : '🔴 Offline'} • ${playerCount}` : 'Unknown', inline: true },
      { name: 'Notifications', value: subscribed ? '🔔 Enabled' : '🔕 Disabled', inline: true },
    ];
  } else if (status) {
    fields = [
      { name: 'Players', value: playerCount, inline: true },
      { name: 'Ping', value: status.pingMs !== undefined ? `${status.pingMs} ms` : '—', inline: true },
      { name: 'Notifications', value: subscribed ? '🔔 Enabled' : '🔕 Disabled', inline: true },
    ];
  }

  if (notice) description += `\n\n${notice}`;

  return {
    content: '',
    embeds: [{ title, description, color, fields, timestamp: status?.checkedAt }],
    components: panelComponents(subscribed),
    allowed_mentions: { parse: [] },
  };
}

function interactionCreate(payload: Record<string, unknown>): Response {
  return json({
    type: 4,
    data: { ...payload, flags: EPHEMERAL },
  });
}

function interactionUpdate(payload: Record<string, unknown>): Response {
  return json({ type: 7, data: payload });
}

function interactionReply(content: string): Response {
  return interactionCreate({ content, allowed_mentions: { parse: [] } });
}

async function handleInteraction(env: Env, interaction: DiscordInteraction): Promise<Response> {
  if (interaction.type === 1) return json({ type: 1 });
  if (interaction.type !== 3) return interactionReply('Unsupported interaction.');

  const customId = interaction.data?.custom_id;
  const userId = getUserId(interaction);
  const status = await getLatestStatus(env);

  // Backwards compatibility for the four-button status card that existed before the panel UI.
  if (customId === 'pz:refresh' || customId === 'pz:players' || customId === 'pz:join' || customId === 'pz:notify') {
    if (customId === 'pz:notify' && !userId) return interactionReply('Could not determine your Discord user ID.');
    const subscribed = customId === 'pz:notify' && userId
      ? await toggleSubscription(env, userId)
      : await isSubscribed(env, userId);
    const view: PanelView = customId === 'pz:players' ? 'players' : customId === 'pz:join' ? 'join' : 'overview';
    return interactionCreate(panelPayload(env, status, subscribed, view));
  }

  if (customId === 'pz:panel') {
    const subscribed = await isSubscribed(env, userId);
    return interactionCreate(panelPayload(env, status, subscribed, 'overview'));
  }

  if (customId?.startsWith('pz:panel:')) {
    if (!userId) return interactionReply('Could not determine your Discord user ID.');

    let subscribed = await isSubscribed(env, userId);
    let view: PanelView = 'overview';
    let notice: string | undefined;

    if (customId === 'pz:panel:refresh') {
      try {
        const result = await triggerServerRefresh(env);
        notice = result.triggered
          ? '🔄 **Fresh probe requested.** GitHub Actions is querying the server now. Give it roughly 10–30 seconds, then press Refresh again to see the new result.'
          : `⏳ A refresh was already requested recently. Try again in about ${result.retryAfterSeconds}s.`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notice = `⚠️ **Could not start a fresh probe.** ${message.slice(0, 180)}`;
      }
    } else if (customId === 'pz:panel:notify') {
      subscribed = await toggleSubscription(env, userId);
    } else if (customId === 'pz:panel:players') {
      view = 'players';
    } else if (customId === 'pz:panel:join') {
      view = 'join';
    }

    const latestStatus = customId === 'pz:panel:refresh' ? await getLatestStatus(env) : status;
    return interactionUpdate(panelPayload(env, latestStatus, subscribed, view, notice));
  }

  return interactionReply('Unknown button.');
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  const expected = `Bearer ${env.MONITOR_API_KEY}`;
  if (request.headers.get('authorization') !== expected) return new Response('Unauthorized', { status: 401 });

  try {
    const status = parseStatus(await request.json());
    const before = await getLatestStatus(env);
    await saveLatestStatus(env, status);
    await syncStatusMessage(env, status);
    await notifyTransition(env, before, status);
    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'pz-discord-bot' });
    }

    if (request.method === 'POST' && url.pathname === '/ingest') {
      return handleIngest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/discord/interactions') {
      const rawBody = await request.text();
      if (!verifyDiscordRequest(request, rawBody, env.DISCORD_PUBLIC_KEY)) {
        return new Response('Invalid request signature', { status: 401 });
      }
      return handleInteraction(env, JSON.parse(rawBody) as DiscordInteraction);
    }

    return new Response('Not found', { status: 404 });
  },
};
