export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startupOrExit } = await import("./lib/startup");
  await startupOrExit();
}
