import { Pool } from "pg";
import { getConfig } from "./config";

const holder = globalThis as typeof globalThis & { inworkspaceConsolePool?: Pool };

/** One pool per process; kept on globalThis so development reloads do not leak connections. */
export function getPool(): Pool {
  if (!holder.inworkspaceConsolePool) {
    const pool = new Pool({
      connectionString: getConfig().databaseUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // An idle client can fail (a database restart, a dropped socket); the pool replaces it.
    pool.on("error", (error) => {
      console.error(JSON.stringify({ severity: "ERROR", message: "console.db.idle-client-error", error: error.message }));
    });
    holder.inworkspaceConsolePool = pool;
  }
  return holder.inworkspaceConsolePool;
}
