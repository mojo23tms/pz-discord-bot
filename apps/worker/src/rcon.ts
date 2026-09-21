import { connect } from 'cloudflare:sockets';

const SERVERDATA_RESPONSE_VALUE = 0;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_AUTH = 3;
const AUTH_ID = 101;
const COMMAND_ID = 102;
const DEFAULT_TIMEOUT_MS = 2200;
const MAX_PACKET_SIZE = 65_536;

export interface RconProbeResult {
  playerNames: string[];
  players: number;
  maxPlayers?: number;
  serverName?: string;
  latencyMs: number;
}

interface RconPacket {
  id: number;
  type: number;
  body: string;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function appendBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

function encodePacket(id: number, type: number, body: string): Uint8Array {
  const bodyBytes = new TextEncoder().encode(body);
  const size = bodyBytes.length + 10;
  const packet = new Uint8Array(size + 4);
  const view = new DataView(packet.buffer);

  view.setInt32(0, size, true);
  view.setInt32(4, id, true);
  view.setInt32(8, type, true);
  packet.set(bodyBytes, 12);
  // Last two bytes are already zero: body terminator + empty second string.
  return packet;
}

class SourceRconClient {
  private readonly socket: ReturnType<typeof connect>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor(
    host: string,
    port: number,
    private readonly timeoutMs: number,
  ) {
    this.socket = connect(
      { hostname: host, port },
      { secureTransport: 'off', allowHalfOpen: false },
    );
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
  }

  async open(): Promise<void> {
    await withTimeout(this.socket.opened.then(() => undefined), this.timeoutMs, 'RCON connect');
  }

  async authenticate(password: string): Promise<void> {
    await this.writePacket(AUTH_ID, SERVERDATA_AUTH, password);

    // Project Zomboid follows Source RCON: an empty RESPONSE_VALUE usually arrives
    // first, followed by AUTH_RESPONSE. Some implementations omit the first packet.
    for (let i = 0; i < 3; i += 1) {
      const packet = await this.readPacket();
      if (packet.type !== SERVERDATA_AUTH_RESPONSE) continue;
      if (packet.id === -1) throw new Error('RCON authentication failed');
      if (packet.id !== AUTH_ID) throw new Error('Unexpected RCON authentication packet id');
      return;
    }

    throw new Error('RCON authentication response was not received');
  }

  async command(command: string): Promise<string> {
    await this.writePacket(COMMAND_ID, SERVERDATA_EXECCOMMAND, command);
    const response = await this.readPacket();

    if (response.id === -1) throw new Error('RCON session is not authenticated');
    if (response.id !== COMMAND_ID || response.type !== SERVERDATA_RESPONSE_VALUE) {
      throw new Error(`Unexpected RCON response (id=${response.id}, type=${response.type})`);
    }

    return response.body;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Best-effort cleanup only.
    }
  }

  private async writePacket(id: number, type: number, body: string): Promise<void> {
    await withTimeout(this.writer.write(encodePacket(id, type, body)), this.timeoutMs, 'RCON write');
  }

  private async readPacket(): Promise<RconPacket> {
    await this.fill(4);
    const headerView = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    const size = headerView.getInt32(0, true);
    if (size < 10 || size > MAX_PACKET_SIZE) {
      throw new Error(`Invalid RCON packet size: ${size}`);
    }

    const total = size + 4;
    await this.fill(total);
    const packetBytes = this.buffer.slice(0, total);
    this.buffer = this.buffer.slice(total);

    const view = new DataView(packetBytes.buffer, packetBytes.byteOffset, packetBytes.byteLength);
    const id = view.getInt32(4, true);
    const type = view.getInt32(8, true);
    const bodyEnd = Math.max(12, total - 2);
    const body = new TextDecoder('utf-8').decode(packetBytes.slice(12, bodyEnd));

    return { id, type, body };
  }

  private async fill(requiredBytes: number): Promise<void> {
    while (this.buffer.length < requiredBytes) {
      const result = await withTimeout(this.reader.read(), this.timeoutMs, 'RCON read');
      if (result.done || !result.value) throw new Error('RCON connection closed unexpectedly');
      this.buffer = appendBytes(this.buffer, result.value);
    }
  }
}

function parsePlayers(raw: string): string[] {
  const lines = raw
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .filter((line) => !/^Players connected\s*\(/i.test(line))
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter((line) => line.length > 0 && !/^none$/i.test(line));
}

function parseOptions(raw: string): { maxPlayers?: number; serverName?: string } {
  let maxPlayers: number | undefined;
  let serverName: string | undefined;

  for (const rawLine of raw.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === 'maxplayers') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) maxPlayers = parsed;
    } else if (key === 'publicname' && value) {
      serverName = value;
    }
  }

  return { maxPlayers, serverName };
}

export async function probeProjectZomboidRcon(
  host: string,
  port: number,
  password: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RconProbeResult> {
  const startedAt = Date.now();
  const client = new SourceRconClient(host, port, timeoutMs);

  try {
    await client.open();
    await client.authenticate(password);
    const playersRaw = await client.command('players');
    const optionsRaw = await client.command('showoptions');
    const playerNames = parsePlayers(playersRaw);
    const options = parseOptions(optionsRaw);

    return {
      playerNames,
      players: playerNames.length,
      maxPlayers: options.maxPlayers,
      serverName: options.serverName,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    client.close();
  }
}

export async function executeProjectZomboidRconCommands(
  host: string,
  port: number,
  password: string,
  commands: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string[]> {
  if (commands.length === 0) return [];

  const client = new SourceRconClient(host, port, timeoutMs);

  try {
    await client.open();
    await client.authenticate(password);

    const responses: string[] = [];
    for (const command of commands) {
      responses.push(await client.command(command));
    }
    return responses;
  } finally {
    client.close();
  }
}
