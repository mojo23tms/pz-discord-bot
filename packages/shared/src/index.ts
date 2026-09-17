export type ServerHealth = 'online' | 'offline';

export interface ServerStatus {
  health: ServerHealth;
  checkedAt: string;
  name?: string;
  host: string;
  port: number;
  players: number;
  maxPlayers: number;
  playerNames: string[];
  pingMs?: number;
  version?: string;
  error?: string;
}
