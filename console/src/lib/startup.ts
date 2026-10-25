import { getConfig } from "./config";
import { getPool } from "./db";
import { migrate } from "./migrations";

/** Fails the server start on invalid configuration or a database that cannot be migrated. */
export async function startup(): Promise<void> {
  const config = getConfig();
  const applied = await migrate(getPool());
  console.log(JSON.stringify({ severity: "INFO", message: "console.started", role: config.role, migrationsApplied: applied }));
}
