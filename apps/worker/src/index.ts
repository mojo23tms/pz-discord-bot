import nacl from 'tweetnacl';
import type { ServerStatus } from '@pz-discord/shared';

interface Env {
  DB: D1Database;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_CHANNEL_ID: string;
  MONITOR_API_KEY: string;
  JOIN_TEXT?: string;
}

interface DiscordInteraction {
  type: number;
  data?: { custom_id?: string };
  member?: { user?: { id?: string } };
  user?: { id?: string };
}

const DISCORD_API = 'https://discord.com/api/v10';
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
  const checkedUnix = Math.floor(new Date(status.checkedAt).getTime() / 1000);

  return {
    content: '',
    embeds: [{
      title: 'BOYS SERVER',
      description: isOnline ? '🟢 Server is responding' : '🔴 Server is unavailable',
      color: isOnline ? 0x57f287 : 0xed4245,
      fields: [
        { name: 'Players', value: players, inline: true },
        { name: 'Ping', value: status.pingMs !== undefined ? `${status.pingMs} ms` : '—', inline: true },
        { name: 'Build', value: status.version ?? '—', inline: true },
        { name: 'Online', value: names, inline: false },
      ],
      footer: { text: status.error ? `Last probe: ${status.error.slice(0, 120)}` : 'Project Zomboid status monitor' },
      timestamp: status.checkedAt,
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 1, label: 'Refresh', custom_id: 'pz:refresh', emoji: { name: '🔄' } },
        { type: 2, style: 2, label: 'Players', custom_id: 'pz:players', emoji: { name: '👥' } },
        { type: 2, style: 2, label: 'How to join', custom_id: 'pz:join', emoji: { name: '🎮' } },
        { type: 2, style: 3, label: 'Notify me', custom_id: 'pz:notify', emoji: { name: '🔔' } },
      ],
    }],
    allowed_mentions: { parse: [] },
    _checkedUnix: checkedUnix,
  };
}

async function discordRequest(env: Env, path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  return response;
}

async function syncStatusMessage(env: Env, status: ServerStatus): Promise<void> {
  const payload = statusMessage(status);
  delete payload._checkedUnix;

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

function interactionReply(content: string): Response {
  return json({
    type: 4,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  });
}

async function handleInteraction(env: Env, interaction: DiscordInteraction): Promise<Response> {
  if (interaction.type === 1) return json({ type: 1 });
  if (interaction.type !== 3) return interactionReply('Unsupported interaction.');

  const customId = interaction.data?.custom_id;
  const status = await getLatestStatus(env);

  if (customId === 'pz:refresh') {
    if (!status) return interactionReply('No server probe has completed yet.');
    const age = Math.max(0, Math.floor((Date.now() - new Date(status.checkedAt).getTime()) / 1000));
    return interactionReply(`Latest probe: **${status.health.toUpperCase()}**, ${status.players}/${status.maxPlayers || '?'} players, checked ${age}s ago. The automatic probe runs every 5 minutes.`);
  }

  if (customId === 'pz:players') {
    if (!status || status.health === 'offline') return interactionReply('Server is currently unavailable.');
    if (!status.playerNames.length) return interactionReply(`Server is online with ${status.players} player(s), but the query did not expose player names.`);
    return interactionReply(`**Online (${status.players})**\n${status.playerNames.map((name) => `• ${name}`).join('\n')}`);
  }

  if (customId === 'pz:join') {
    return interactionReply(env.JOIN_TEXT?.trim() || 'Join instructions have not been configured yet.');
  }

  if (customId === 'pz:notify') {
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!userId) return interactionReply('Could not determine your Discord user ID.');

    const current = await env.DB.prepare('SELECT discord_user_id FROM subscriptions WHERE discord_user_id = ?')
      .bind(userId).first<{ discord_user_id: string }>();

    if (current) {
      await env.DB.prepare('DELETE FROM subscriptions WHERE discord_user_id = ?').bind(userId).run();
      return interactionReply('🔕 Server status notifications disabled for you.');
    }

    await env.DB.prepare('INSERT INTO subscriptions (discord_user_id, created_at) VALUES (?, ?)')
      .bind(userId, Date.now()).run();
    return interactionReply('🔔 You will be mentioned when the server changes between online and offline.');
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
