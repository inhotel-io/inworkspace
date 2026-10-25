import { apiPreflight, apiRoute } from "@/lib/api";
import { ApiError } from "@/lib/apiRoute";
import type { ThreadResponse } from "@/lib/apiTypes";
import { audit } from "@/lib/audit";
import { getThread } from "@/lib/mailbox";
import { decodeAddressParam, isThreadId } from "@/lib/params";
import { findAgent, jmapClient, principalCredentials } from "@/lib/services";

export const GET = apiRoute<{ address: string; threadId: string }>(async ({ operator, params }): Promise<ThreadResponse> => {
  if (!isThreadId(params.threadId)) throw new ApiError(404, "not_found", "There is no such conversation.");
  const agent = await findAgent(decodeAddressParam(params.address));
  if (!agent) throw new ApiError(404, "not_found", "There is no agent at this address.");
  audit({ operator: operator.login, agent: agent.address, threadId: params.threadId });
  const messages = await getThread(jmapClient(), principalCredentials(), agent.address, params.threadId);
  if (messages === null) throw new ApiError(404, "not_found", "This mailbox has no such conversation.");
  return { agent: { address: agent.address, name: agent.name }, messages };
});
export const OPTIONS = apiPreflight;
