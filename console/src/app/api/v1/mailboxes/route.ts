import { apiPreflight, apiRoute } from "@/lib/api";
import type { MailboxesResponse } from "@/lib/apiTypes";
import { getMailboxes } from "@/lib/services";

export const GET = apiRoute(
  async (): Promise<MailboxesResponse> => ({ mailboxes: (await getMailboxes()).mailboxes.map(({ address, name }) => ({ address, name })) }),
);
export const OPTIONS = apiPreflight;
