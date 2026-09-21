import type { ServerStatus } from '@pz-discord/shared';
import { executeProjectZomboidRconCommands } from './rcon.js';

export interface MaintenanceEnv {
  DB: D1Database;
  DISCORD_BOT_TOKEN: string;
  DISCORD_CHANNEL_ID: string;
  RCON_HOST: string;
  RCON_PORT: string;
  RCON_PASSWORD: string;
  RESTART_ANCHOR_UTC?: string;
  RESTART_TIMEZONE?: string;
  RESTART_START_LOCAL?: string;
  RESTART_INTERVAL_HOURS?: string;
  RESTART_DOWNTIME_MINUTES?: string;
  RESTART_RECOVERY_GRACE_MINUTES?: string;
  WORKSHOP_IDS?: string;
  WORKSHOP_POLL_MINUTES?: string;
}

export interface MaintenanceSnapshot {
  nextRestartAtMs?: number;
  pendingMods: number;
  pendingTitles: string[];
}

interface RestartCycleRow {
  restart_at: number;
  warn_60_at: number | null;
  warn_30_at: number | null;
  warn_5_at: number | null;
  warn_1_at: number | null;
  save_at: number | null;
  outage_seen_at: number | null;
  recovered_at: number | null;
  failure_alert_at: number | null;
  failure_alert_message_id: string | null;
}

interface WorkshopRow {
  workshop_id: string;
  title: string | null;
  steam_updated_at: number;
  pending_since: number | null;
  pending_steam_updated_at: number | null;
  active: number;
}

interface SteamPublishedFileDetail {
  publishedfileid?: string;
  result?: number;
  title?: string;
  time_updated?: number;
}

interface SteamPublishedFileResponse {
  response?: {
    result?: number;
    resultcount?: number;
    publishedfiledetails?: SteamPublishedFileDetail[];
  };
}

const DISCORD_API = 'https://discord.com/api/v10';
const STEAM_DETAILS_API = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const MOD_POLL_SETTING_KEY = 'workshop_last_polled_at';
const MOD_ALERT_SETTING_KEY = 'workshop_update_alert_message_id';
const DEFAULT_RESTART_INTERVAL_HOURS = 6;
const DEFAULT_RESTART_DOWNTIME_MINUTES = 10;
const DEFAULT_RESTART_RECOVERY_GRACE_MINUTES = 5;
const DEFAULT_WORKSHOP_POLL_MINUTES = 15;

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rconPort(env: MaintenanceEnv): number {
  const port = Number.parseInt(env.RCON_PORT, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65_535) throw new Error('Invalid RCON_PORT');
  return port;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(timestampMs: number, timeZone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const values = new Map(formatter.formatToParts(new Date(timestampMs)).map((part) => [part.type, part.value]));

  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
  };
}

function parseLocalClock(raw: string | undefined): { hour: number; minute: number } | null {
  const match = raw?.trim().match(/^(\\d{1,2}):(\\d{2})$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function zonedLocalToUtcMs(parts: LocalDateParts, timeZone: string): number {
  const desiredPseudoUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  let guess = desiredPseudoUtc;

  // Resolve the time-zone offset iteratively. The scheduled hours are deliberately
  // away from DST transition gaps, but this also keeps the calculation generic.
  for (let i = 0; i < 4; i += 1) {
    const actual = localParts(guess, timeZone);
    const actualPseudoUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      0,
      0,
    );
    const delta = desiredPseudoUtc - actualPseudoUtc;
    if (delta === 0) return guess;
    guess += delta;
  }

  return guess;
}

function addLocalDays(parts: LocalDateParts, days: number): LocalDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

function localScheduleCandidates(env: MaintenanceEnv, now: number): number[] | null {
  const timeZone = env.RESTART_TIMEZONE?.trim();
  const start = parseLocalClock(env.RESTART_START_LOCAL);
  if (!timeZone || !start) return null;

  // Validate the IANA zone early.
  try {
    localParts(now, timeZone);
  } catch {
    return null;
  }

  const intervalHours = parsePositiveNumber(env.RESTART_INTERVAL_HOURS, DEFAULT_RESTART_INTERVAL_HOURS);
  const intervalMinutes = intervalHours * 60;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0 || intervalMinutes > 24 * 60) return null;

  const targetMinutes = new Set<number>();
  const startMinutes = start.hour * 60 + start.minute;
  for (let offset = 0; offset < 24 * 60; offset += intervalMinutes) {
    targetMinutes.add((startMinutes + offset) % (24 * 60));
    if (targetMinutes.size > 24 * 60) break;
  }

  const localNow = localParts(now, timeZone);
  const candidates: number[] = [];

  for (const dayOffset of [-1, 0, 1, 2]) {
    const date = addLocalDays(localNow, dayOffset);
    for (const minuteOfDay of targetMinutes) {
      const hour = Math.floor(minuteOfDay / 60);
      const minute = minuteOfDay % 60;
      candidates.push(zonedLocalToUtcMs({ ...date, hour, minute }, timeZone));
    }
  }

  return [...new Set(candidates)].sort((a, b) => a - b);
}

function utcAnchorSchedule(env: MaintenanceEnv): { anchorMs: number; intervalMs: number } | null {
  if (!env.RESTART_ANCHOR_UTC?.trim()) return null;
  const anchorMs = Date.parse(env.RESTART_ANCHOR_UTC);
  if (!Number.isFinite(anchorMs)) return null;

  const intervalHours = parsePositiveNumber(env.RESTART_INTERVAL_HOURS, DEFAULT_RESTART_INTERVAL_HOURS);
  return { anchorMs, intervalMs: intervalHours * 60 * 60_000 };
}

export function nextRestartAtMs(env: MaintenanceEnv, now = Date.now()): number | undefined {
  const localCandidates = localScheduleCandidates(env, now);
  if (localCandidates) return localCandidates.find((candidate) => candidate >= now);

  // Backwards-compatible fixed-UTC mode. Prefer RESTART_TIMEZONE +
  // RESTART_START_LOCAL for schedules that follow local wall time across DST.
  const schedule = utcAnchorSchedule(env);
  if (!schedule) return undefined;
  if (now <= schedule.anchorMs) return schedule.anchorMs;

  const intervalsElapsed = Math.floor((now - schedule.anchorMs) / schedule.intervalMs) + 1;
  return schedule.anchorMs + intervalsElapsed * schedule.intervalMs;
}

function previousRestartAtMs(env: MaintenanceEnv, now = Date.now()): number | undefined {
  const localCandidates = localScheduleCandidates(env, now);
  if (localCandidates) {
    for (let i = localCandidates.length - 1; i >= 0; i -= 1) {
      const candidate = localCandidates[i];
      if (candidate !== undefined && candidate <= now) return candidate;
    }
    return undefined;
  }

  const schedule = utcAnchorSchedule(env);
  if (!schedule || now < schedule.anchorMs) return undefined;

  const intervalsElapsed = Math.floor((now - schedule.anchorMs) / schedule.intervalMs);
  return schedule.anchorMs + intervalsElapsed * schedule.intervalMs;
}

function restartDowntimeMs(env: MaintenanceEnv): number {
  return parsePositiveNumber(env.RESTART_DOWNTIME_MINUTES, DEFAULT_RESTART_DOWNTIME_MINUTES) * 60_000;
}

function restartRecoveryGraceMs(env: MaintenanceEnv): number {
  return parsePositiveNumber(env.RESTART_RECOVERY_GRACE_MINUTES, DEFAULT_RESTART_RECOVERY_GRACE_MINUTES) * 60_000;
}

export function isPlannedMaintenanceWindow(env: MaintenanceEnv, now = Date.now()): boolean {
  const next = nextRestartAtMs(env, now);
  if (next !== undefined && next - now >= 0 && next - now <= 2 * 60_000) return true;

  const previous = previousRestartAtMs(env, now);
  if (previous === undefined) return false;

  const expectedStartAt = previous + restartDowntimeMs(env);
  return now - previous >= 0 && now <= expectedStartAt + restartRecoveryGraceMs(env);
}

async function getSetting(env: MaintenanceEnv, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(env: MaintenanceEnv, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(key, value).run();
}

async function deleteSetting(env: MaintenanceEnv, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

async function discordRequest(env: MaintenanceEnv, path: string, init: RequestInit): Promise<Response> {
  return fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function postDiscordMessage(env: MaintenanceEnv, content: string): Promise<string | null> {
  const response = await discordRequest(env, `/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
    }),
  });

  if (!response.ok) {
    console.error('Maintenance Discord message failed', response.status, (await response.text()).slice(0, 300));
    return null;
  }

  const body = await response.json() as { id?: string };
  return body.id ?? null;
}

async function deleteDiscordMessage(env: MaintenanceEnv, messageId: string | null): Promise<void> {
  if (!messageId) return;
  const response = await discordRequest(env, `/channels/${env.DISCORD_CHANNEL_ID}/messages/${messageId}`, {
    method: 'DELETE',
  });

  if (!response.ok && response.status !== 404) {
    console.error('Maintenance Discord delete failed', response.status, (await response.text()).slice(0, 300));
  }
}

async function ensureRestartCycle(env: MaintenanceEnv, restartAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO restart_cycles (restart_at, created_at)
     VALUES (?, ?)
     ON CONFLICT(restart_at) DO NOTHING`,
  ).bind(restartAt, Date.now()).run();
}

async function getRestartCycle(env: MaintenanceEnv, restartAt: number): Promise<RestartCycleRow | null> {
  return env.DB.prepare(
    `SELECT restart_at, warn_60_at, warn_30_at, warn_5_at, warn_1_at, save_at,
            outage_seen_at, recovered_at, failure_alert_at, failure_alert_message_id
       FROM restart_cycles
      WHERE restart_at = ?`,
  ).bind(restartAt).first<RestartCycleRow>();
}

function quoteServerMessage(message: string): string {
  const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `servermsg "${escaped}"`;
}

function warningText(milestoneMinutes: number, remainingMs: number): string {
  const actualMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const closeToMilestone = Math.abs(actualMinutes - milestoneMinutes) <= 2;
  const minutes = closeToMilestone ? milestoneMinutes : actualMinutes;

  if (minutes === 60) return 'SERVER: Planned maintenance in 1 hour.';
  if (minutes === 1) return 'SERVER: Planned maintenance in 1 minute. Saving world now.';
  if (minutes <= 5) {
    return `SERVER: Planned maintenance in about ${minutes} minute${minutes === 1 ? '' : 's'}. Find a safe place and finish what you are doing.`;
  }
  return `SERVER: Planned maintenance in about ${minutes} minutes.`;
}

async function markCycleColumn(
  env: MaintenanceEnv,
  restartAt: number,
  column: 'warn_60_at' | 'warn_30_at' | 'warn_5_at' | 'warn_1_at' | 'save_at' | 'outage_seen_at' | 'recovered_at',
  value: number,
): Promise<void> {
  await env.DB.prepare(`UPDATE restart_cycles SET ${column} = ? WHERE restart_at = ?`)
    .bind(value, restartAt)
    .run();
}

async function processRestartWarnings(
  env: MaintenanceEnv,
  status: ServerStatus,
  now: number,
  restartAt: number,
): Promise<void> {
  const remainingMs = restartAt - now;
  if (remainingMs <= 0 || remainingMs > 60 * 60_000) return;

  await ensureRestartCycle(env, restartAt);
  const cycle = await getRestartCycle(env, restartAt);
  if (!cycle) return;

  const milestones = [
    { minutes: 60, lowerMinutes: 30, column: 'warn_60_at' as const },
    { minutes: 30, lowerMinutes: 5, column: 'warn_30_at' as const },
    { minutes: 5, lowerMinutes: 1, column: 'warn_5_at' as const },
    { minutes: 1, lowerMinutes: 0, column: 'warn_1_at' as const },
  ];

  for (const milestone of milestones) {
    const upper = milestone.minutes * 60_000;
    const lower = milestone.lowerMinutes * 60_000;
    if (!(remainingMs <= upper && remainingMs > lower)) continue;
    if (cycle[milestone.column] !== null) break;

    if (status.health !== 'online') break;

    if (status.players > 0) {
      try {
        await executeProjectZomboidRconCommands(
          env.RCON_HOST,
          rconPort(env),
          env.RCON_PASSWORD,
          [quoteServerMessage(warningText(milestone.minutes, remainingMs))],
        );
        await markCycleColumn(env, restartAt, milestone.column, now);
      } catch (error) {
        console.error(`Failed to send restart warning ${milestone.minutes}m`, error);
      }
    } else {
      // -1 means the milestone was intentionally skipped because nobody was online.
      await markCycleColumn(env, restartAt, milestone.column, -1);
    }
    break;
  }

  if (remainingMs <= 90_000 && cycle.save_at === null && status.health === 'online') {
    try {
      await executeProjectZomboidRconCommands(
        env.RCON_HOST,
        rconPort(env),
        env.RCON_PASSWORD,
        ['save'],
      );
      await markCycleColumn(env, restartAt, 'save_at', now);
    } catch (error) {
      console.error('Failed to issue pre-restart save', error);
    }
  }
}

function parseWorkshopIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const token of raw.split(/[;,\s]+/)) {
    const id = token.trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

async function pendingMods(env: MaintenanceEnv): Promise<{ count: number; titles: string[] }> {
  const [countRow, titleRows] = await Promise.all([
    env.DB.prepare(
      'SELECT COUNT(*) AS count FROM workshop_items WHERE active = 1 AND pending_steam_updated_at IS NOT NULL',
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(title, workshop_id) AS title
         FROM workshop_items
        WHERE active = 1 AND pending_steam_updated_at IS NOT NULL
        ORDER BY pending_since ASC
        LIMIT 5`,
    ).all<{ title: string }>(),
  ]);

  return {
    count: Number(countRow?.count ?? 0),
    titles: titleRows.results.map((row) => row.title),
  };
}

async function fetchWorkshopDetails(ids: string[]): Promise<SteamPublishedFileDetail[]> {
  const body = new URLSearchParams();
  body.set('itemcount', String(ids.length));
  ids.forEach((id, index) => body.set(`publishedfileids[${index}]`, id));

  const response = await fetch(STEAM_DETAILS_API, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`Steam Workshop details failed: HTTP ${response.status}`);

  const payload = await response.json() as SteamPublishedFileResponse;
  return payload.response?.publishedfiledetails ?? [];
}

async function createWorkshopUpdateAlert(env: MaintenanceEnv): Promise<void> {
  const pending = await pendingMods(env);
  if (pending.count === 0) return;

  const oldId = await getSetting(env, MOD_ALERT_SETTING_KEY);
  if (oldId) await deleteDiscordMessage(env, oldId);

  const names = pending.titles.map((title) => `• ${title}`).join('\n');
  const extra = pending.count > pending.titles.length
    ? `\n…and ${pending.count - pending.titles.length} more.`
    : '';
  const messageId = await postDiscordMessage(
    env,
    `🧩 **Workshop update detected.**\n${pending.count} configured mod${pending.count === 1 ? '' : 's'} changed since the last synchronized restart.\n${names}${extra}\n\nThe server will keep running and batch these updates into the next planned maintenance restart.`,
  );
  if (messageId) await setSetting(env, MOD_ALERT_SETTING_KEY, messageId);
}

async function clearWorkshopAlertIfResolved(env: MaintenanceEnv): Promise<void> {
  const pending = await pendingMods(env);
  if (pending.count !== 0) return;

  const messageId = await getSetting(env, MOD_ALERT_SETTING_KEY);
  if (messageId) {
    await deleteDiscordMessage(env, messageId);
    await deleteSetting(env, MOD_ALERT_SETTING_KEY);
  }
}

async function pollWorkshop(env: MaintenanceEnv, now: number): Promise<void> {
  const ids = parseWorkshopIds(env.WORKSHOP_IDS);
  if (ids.length === 0) return;

  const pollMinutes = parsePositiveNumber(env.WORKSHOP_POLL_MINUTES, DEFAULT_WORKSHOP_POLL_MINUTES);
  const rawLastPolled = await getSetting(env, MOD_POLL_SETTING_KEY);
  const lastPolled = Number(rawLastPolled ?? 0);
  if (Number.isFinite(lastPolled) && lastPolled > 0 && now - lastPolled < pollMinutes * 60_000) return;

  // Record the attempt up front so a transient Steam failure does not hammer the API every minute.
  await setSetting(env, MOD_POLL_SETTING_KEY, String(now));

  const before = await pendingMods(env);
  const details = await fetchWorkshopDetails(ids);
  const existingRows = await env.DB.prepare(
    `SELECT workshop_id, title, steam_updated_at, pending_since, pending_steam_updated_at, active
       FROM workshop_items`,
  ).all<WorkshopRow>();
  const existing = new Map(existingRows.results.map((row) => [row.workshop_id, row]));

  const statements: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE workshop_items SET active = 0'),
  ];

  for (const detail of details) {
    const id = detail.publishedfileid;
    const steamUpdatedAt = Number(detail.time_updated ?? 0) * 1000;
    if (!id || !ids.includes(id) || detail.result !== 1 || !Number.isFinite(steamUpdatedAt) || steamUpdatedAt <= 0) {
      continue;
    }

    const title = detail.title?.trim() || null;
    const previous = existing.get(id);

    if (!previous) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO workshop_items
             (workshop_id, title, steam_updated_at, first_seen_at, last_checked_at, pending_since, pending_steam_updated_at, active)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, 1)`,
        ).bind(id, title, steamUpdatedAt, now, now),
      );
      continue;
    }

    const changed = steamUpdatedAt > previous.steam_updated_at;
    const pendingSince = changed && previous.pending_since === null ? now : previous.pending_since;
    const pendingSteamUpdatedAt = changed
      ? Math.max(steamUpdatedAt, previous.pending_steam_updated_at ?? 0)
      : previous.pending_steam_updated_at;

    statements.push(
      env.DB.prepare(
        `UPDATE workshop_items
            SET title = ?,
                steam_updated_at = ?,
                last_checked_at = ?,
                pending_since = ?,
                pending_steam_updated_at = ?,
                active = 1
          WHERE workshop_id = ?`,
      ).bind(title, Math.max(steamUpdatedAt, previous.steam_updated_at), now, pendingSince, pendingSteamUpdatedAt, id),
    );
  }

  await env.DB.batch(statements);

  const after = await pendingMods(env);
  if (before.count === 0 && after.count > 0) {
    await createWorkshopUpdateAlert(env);
  }
}

async function clearHandledWorkshopUpdates(env: MaintenanceEnv, restartAt: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE workshop_items
        SET pending_since = NULL,
            pending_steam_updated_at = NULL
      WHERE active = 1
        AND pending_steam_updated_at IS NOT NULL
        AND pending_steam_updated_at <= ?`,
  ).bind(restartAt).run();

  await clearWorkshopAlertIfResolved(env);
}

async function processRestartObservation(
  env: MaintenanceEnv,
  status: ServerStatus,
  now: number,
  restartAt: number,
): Promise<void> {
  const downtimeMs = restartDowntimeMs(env);
  const recoveryGraceMs = restartRecoveryGraceMs(env);
  const expectedStartAt = restartAt + downtimeMs;
  const observationEnd = expectedStartAt + recoveryGraceMs + 5 * 60_000;

  if (now < restartAt || now > observationEnd) return;

  await ensureRestartCycle(env, restartAt);
  const cycle = await getRestartCycle(env, restartAt);
  if (!cycle) return;

  if (status.health === 'offline') {
    if (cycle.outage_seen_at === null) {
      await markCycleColumn(env, restartAt, 'outage_seen_at', now);
    }

    if (now >= expectedStartAt + recoveryGraceMs && cycle.failure_alert_at === null) {
      const graceMinutes = Math.round(recoveryGraceMs / 60_000);
      const messageId = await postDiscordMessage(
        env,
        `🔴 **Planned maintenance has not recovered normally.**\nThe server is still unreachable more than ${graceMinutes} minutes after its scheduled start (<t:${Math.floor(expectedStartAt / 1000)}:t>). HostHavoc may need manual attention.`,
      );

      await env.DB.prepare(
        `UPDATE restart_cycles
            SET failure_alert_at = ?,
                failure_alert_message_id = ?
          WHERE restart_at = ?`,
      ).bind(now, messageId, restartAt).run();
    }
    return;
  }

  if (cycle.outage_seen_at !== null && cycle.recovered_at === null && now >= restartAt) {
    await markCycleColumn(env, restartAt, 'recovered_at', now);
    await clearHandledWorkshopUpdates(env, restartAt);

    if (cycle.failure_alert_message_id) {
      await deleteDiscordMessage(env, cycle.failure_alert_message_id);
    }
  }
}

export async function getMaintenanceSnapshot(env: MaintenanceEnv, now = Date.now()): Promise<MaintenanceSnapshot> {
  const pending = await pendingMods(env);
  return {
    nextRestartAtMs: nextRestartAtMs(env, now),
    pendingMods: pending.count,
    pendingTitles: pending.titles,
  };
}

export async function runMaintenanceTick(
  env: MaintenanceEnv,
  status: ServerStatus,
  now = Date.now(),
): Promise<void> {
  const nextRestart = nextRestartAtMs(env, now);
  if (nextRestart !== undefined) {
    await processRestartWarnings(env, status, now, nextRestart);
  }

  const previousRestart = previousRestartAtMs(env, now);
  if (previousRestart !== undefined) {
    await processRestartObservation(env, status, now, previousRestart);
  }

  try {
    await pollWorkshop(env, now);
  } catch (error) {
    console.error('Workshop polling failed', error);
  }

  // Keep only a small history of completed maintenance cycles.
  await env.DB.prepare('DELETE FROM restart_cycles WHERE restart_at < ?')
    .bind(now - 30 * 24 * 60 * 60_000)
    .run();
}
