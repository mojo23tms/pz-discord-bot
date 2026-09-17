import { GameDig } from 'gamedig';
import type { ServerStatus } from '@pz-discord/shared';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function numberFromEnv(name: string, fallback?: number): number {
  const raw = process.env[name]?.trim();
  if (!raw && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric environment variable: ${name}`);
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

async function queryServer(host: string, port: number): Promise<ServerStatus> {
  const checkedAt = new Date().toISOString();
  const timeout = numberFromEnv('PZ_TIMEOUT_MS', 7000);

  try {
    const state = await GameDig.query({
      type: 'projectzomboid',
      host,
      port,
      maxAttempts: 2,
      socketTimeout: timeout,
      attemptTimeout: timeout,
    });

    const playerNames = (state.players ?? [])
      .map((player) => player.name?.trim())
      .filter((name): name is string => Boolean(name));

    return {
      health: 'online',
      checkedAt,
      name: state.name || undefined,
      host,
      port,
      players: state.numplayers ?? playerNames.length,
      maxPlayers: state.maxplayers ?? 0,
      playerNames,
      pingMs: Number.isFinite(state.ping) ? state.ping : undefined,
      version: state.version || undefined,
    };
  } catch (error) {
    return {
      health: 'offline',
      checkedAt,
      host,
      port,
      players: 0,
      maxPlayers: 0,
      playerNames: [],
      error: safeError(error),
    };
  }
}

async function publish(status: ServerStatus): Promise<void> {
  const ingestUrl = required('WORKER_INGEST_URL');
  const apiKey = required('MONITOR_API_KEY');

  const response = await fetch(ingestUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(status),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Worker ingest failed: ${response.status} ${body.slice(0, 500)}`);
  }
}

async function main(): Promise<void> {
  const host = required('PZ_HOST');
  const port = numberFromEnv('PZ_PORT');
  const status = await queryServer(host, port);

  console.log(JSON.stringify(status, null, 2));
  await publish(status);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
