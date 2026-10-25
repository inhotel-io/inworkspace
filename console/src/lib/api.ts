import "server-only";
import { createApiRoute, createPreflight, type ApiRouteDeps } from "./apiRoute";
import { getConfig, servesApi } from "./config";
import { operatorVerifier } from "./services";

const deps: ApiRouteDeps = {
  enabled: () => servesApi(getConfig()),
  allowedOrigin: () => new URL(getConfig().jmapUrl).origin,
  verify: (headers) => operatorVerifier()(headers),
  log: (entry) => console.log(JSON.stringify(entry)),
};

export const apiRoute = createApiRoute(deps);
export const apiPreflight = createPreflight(deps);
