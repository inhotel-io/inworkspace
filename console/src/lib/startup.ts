import { readExposure } from "./cloudRunGuard";
import { getConfig, servesWeb, type ConsoleConfig } from "./config";
import { getPool } from "./db";
import { migrate } from "./migrations";

const EXPOSURE_RECHECK_MS = 5 * 60 * 1000;

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/**
 * AUTH_MODE=cloud-run trusts identities only while the service is private: refuse to start unless
 * that can be confirmed, and exit if it ever stops being true.
 */
async function guardCloudRun(config: ConsoleConfig): Promise<void> {
  if (config.authMode !== "cloud-run" || !servesWeb(config)) return;
  const service = process.env.K_SERVICE;
  if (!service) throw new Error("AUTH_MODE=cloud-run only runs on Cloud Run (K_SERVICE is not set)");
  const exposed = await readExposure(service);
  if (exposed) throw new Error(`refusing to start with AUTH_MODE=cloud-run: ${exposed}, so caller identities could be forged`);

  const timer = setInterval(() => {
    readExposure(service).then(
      (reason) => {
        if (!reason) return;
        log({ severity: "CRITICAL", message: "console.exposed", reason });
        process.exit(1);
      },
      (error: unknown) => {
        log({ severity: "WARNING", message: "console.exposure-check-failed", error: error instanceof Error ? error.message : String(error) });
      },
    );
  }, EXPOSURE_RECHECK_MS);
  timer.unref();
}

/** Validates the configuration, checks the deployment and applies migrations; throws when any fails. */
export async function startup(): Promise<void> {
  const config = getConfig();
  await guardCloudRun(config);
  const applied = await migrate(getPool());
  log({ severity: "INFO", message: "console.started", role: config.role, authMode: config.authMode, migrationsApplied: applied });
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
