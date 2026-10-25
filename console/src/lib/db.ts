import { Pool } from "pg";
import { getConfig } from "./config";

const holder = globalThis as typeof globalThis & { inworkspaceConsolePool?: Pool };

/** One pool per process; kept on globalThis so development reloads do not leak connections. */
export function getPool(): Pool {
  holder.inworkspaceConsolePool ??= new Pool({
    connectionString: getConfig().databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return holder.inworkspaceConsolePool;
}
