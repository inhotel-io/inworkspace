import { apiPreflight, apiRoute } from "@/lib/api";
import { ApiError } from "@/lib/apiRoute";
import type { ThreadResponse } from "@/lib/apiTypes";
import { audit } from "@/lib/audit";
import { getThread } from "@/lib/mailbox";
import { decodeAddressParam, isThreadId } from "@/lib/params";
import { findMailbox, jmapClient, principalCredentials } from "@/lib/services";

export const GET = apiRoute<{ address: string; threadId: string }>(async ({ operator, params }): Promise<ThreadResponse> => {
  if (!isThreadId(params.threadId)) throw new ApiError(404, "not_found", "There is no such conversation.");
  const mailbox = await findMailbox(decodeAddressParam(params.address));
  if (!mailbox) throw new ApiError(404, "not_found", "There is no mailbox at this address.");
  audit({ operator: operator.login, mailbox: mailbox.address, threadId: params.threadId });
  const messages = await getThread(jmapClient(), principalCredentials(), mailbox.address, params.threadId);
  if (messages === null) throw new ApiError(404, "not_found", "This mailbox has no such conversation.");
  return { mailbox: { address: mailbox.address, name: mailbox.name }, messages };
});
export const OPTIONS = apiPreflight;
