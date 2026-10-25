import { apiPreflight, apiRoute } from "@/lib/api";
import type { MeResponse } from "@/lib/apiTypes";

export const GET = apiRoute(async ({ operator }): Promise<MeResponse> => ({ login: operator.login }));
export const OPTIONS = apiPreflight;
