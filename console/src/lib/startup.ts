import path from "node:path";
import { getConfig, servesApi } from "./config";
import { getPool } from "./db";
import { migrate } from "./migrations";
import { buildUiBundle, uiSettingsFrom } from "./uiBundle";

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/** Validates the configuration, applies migrations and, in the api role, builds the web app's bundle; throws when any fails. */
export async function startup(): Promise<void> {
  const config = getConfig();
  const applied = await migrate(getPool());
  const bundle = servesApi(config) ? await buildUiBundle(path.resolve(config.uiDistDir), uiSettingsFrom(config)) : null;
  log({
    severity: "INFO",
    message: "console.started",
    role: config.role,
    authMode: servesApi(config) ? config.authMode : null,
    migrationsApplied: applied,
    uiVersion: bundle?.version ?? null,
  });
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
