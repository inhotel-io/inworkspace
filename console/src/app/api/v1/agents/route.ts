import { apiPreflight, apiRoute } from "@/lib/api";
import type { AgentsResponse } from "@/lib/apiTypes";
import { getAgents } from "@/lib/services";

export const GET = apiRoute(
  async (): Promise<AgentsResponse> => ({ agents: (await getAgents()).map(({ address, name }) => ({ address, name })) }),
);
export const OPTIONS = apiPreflight;
