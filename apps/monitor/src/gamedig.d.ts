declare module 'gamedig' {
  export interface QueryPlayer {
    name?: string;
  }

  export interface QueryState {
    name?: string;
    players?: QueryPlayer[];
    numplayers?: number;
    maxplayers?: number;
    ping?: number;
    version?: string;
  }

  export interface QueryOptions {
    type: string;
    host: string;
    port: number;
    maxAttempts?: number;
    socketTimeout?: number;
    attemptTimeout?: number;
  }

  export const GameDig: {
    query(options: QueryOptions): Promise<QueryState>;
  };
}
