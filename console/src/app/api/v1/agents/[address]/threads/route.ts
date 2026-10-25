import { apiPreflight, apiRoute } from "@/lib/api";
import { ApiError } from "@/lib/apiRoute";
import type { ThreadsResponse } from "@/lib/apiTypes";
import { audit } from "@/lib/audit";
import { listThreads, THREAD_PAGE_SIZE } from "@/lib/mailbox";
import { decodeAddressParam, parsePosition } from "@/lib/params";
import { findAgent, jmapClient, principalCredentials } from "@/lib/services";

export const GET = apiRoute<{ address: string }>(async ({ request, operator, params }): Promise<ThreadsResponse> => {
  const agent = await findAgent(decodeAddressParam(params.address));
  if (!agent) throw new ApiError(404, "not_found", "There is no agent at this address.");
  const position = parsePosition(new URL(request.url).searchParams.get("position") ?? undefined);
  audit({ operator: operator.login, agent: agent.address });
  const page = await listThreads(jmapClient(), principalCredentials(), agent.address, position);
  return {
    agent: { address: agent.address, name: agent.name },
    threads: page.threads,
    total: page.total,
    position: page.position,
    pageSize: THREAD_PAGE_SIZE,
  };
});
export const OPTIONS = apiPreflight;
