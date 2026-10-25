import { getConfig } from "./config";
import { getPool } from "./db";
import { migrate } from "./migrations";

/** Validates the configuration and applies migrations; throws when either fails. */
export async function startup(): Promise<void> {
  const config = getConfig();
  const applied = await migrate(getPool());
  console.log(JSON.stringify({ severity: "INFO", message: "console.started", role: config.role, migrationsApplied: applied }));
}

/** Next.js logs a failing instrumentation hook and keeps serving, so a broken start exits the process instead. */
export async function startupOrExit(): Promise<void> {
  try {
    await startup();
  } catch (error) {
    console.error(
      JSON.stringify({
        severity: "CRITICAL",
        message: "console.startup-failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  }
}
