import { apiPreflight, apiRoute } from "@/lib/api";
import { ApiError } from "@/lib/apiRoute";
import type { ThreadsResponse } from "@/lib/apiTypes";
import { audit } from "@/lib/audit";
import { listThreads, THREAD_PAGE_SIZE } from "@/lib/mailbox";
import { decodeAddressParam, parsePosition } from "@/lib/params";
import { findMailbox, jmapClient, principalCredentials } from "@/lib/services";

export const GET = apiRoute<{ address: string }>(async ({ request, operator, params }): Promise<ThreadsResponse> => {
  const mailbox = await findMailbox(decodeAddressParam(params.address));
  if (!mailbox) throw new ApiError(404, "not_found", "There is no mailbox at this address.");
  const search = new URL(request.url).searchParams;
  const position = parsePosition(search.get("position") ?? undefined);
  // The web app asks again every half minute while a mailbox is open; those reads are marked.
  audit({ operator: operator.login, mailbox: mailbox.address, automatic: search.get("refresh") === "1" });
  const page = await listThreads(jmapClient(), principalCredentials(), mailbox.address, position);
  return {
    mailbox: { address: mailbox.address, name: mailbox.name },
    threads: page.threads,
    total: page.total,
    position: page.position,
    pageSize: THREAD_PAGE_SIZE,
  };
});
export const OPTIONS = apiPreflight;
