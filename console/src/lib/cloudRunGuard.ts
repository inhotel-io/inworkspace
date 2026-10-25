// AUTH_MODE=cloud-run trusts identities that Cloud Run's IAM check verified. That is only true while
// the service cannot be invoked without IAM, so the web role refuses to start, and later exits, as
// soon as it can.

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const METADATA = "http://metadata.google.internal/computeMetadata/v1/";
const OPEN_MEMBERS = new Set(["allUsers", "allAuthenticatedUsers"]);

interface ServiceResource {
  invokerIamDisabled?: boolean;
}

interface IamPolicy {
  bindings?: { role: string; members?: string[] }[];
}

/** Why the service can be invoked without IAM, or null when it cannot. */
export function exposure(service: ServiceResource, policy: IamPolicy): string | null {
  if (service.invokerIamDisabled === true) return "the service has its IAM invoker check disabled";
  for (const binding of policy.bindings ?? []) {
    if (binding.role !== "roles/run.invoker") continue;
    const open = (binding.members ?? []).find((member) => OPEN_MEMBERS.has(member));
    if (open) return `roles/run.invoker is granted to ${open}`;
  }
  return null;
}

/** Reads this service and its IAM policy with the instance's own identity. Throws when either cannot be read. */
export async function readExposure(serviceName: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  const metadata = async (path: string): Promise<Response> => {
    const response = await fetchImpl(`${METADATA}${path}`, { headers: { "Metadata-Flavor": "Google" } });
    if (!response.ok) throw new Error(`the metadata server answered HTTP ${response.status} for ${path}`);
    return response;
  };
  const project = (await (await metadata("project/project-id")).text()).trim();
  const region = (await (await metadata("instance/region")).text()).trim().split("/").pop();
  const { access_token: token } = (await (await metadata("instance/service-accounts/default/token")).json()) as { access_token: string };

  const resource = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${serviceName}`;
  const headers = { Authorization: `Bearer ${token}` };
  const [service, policy] = await Promise.all([fetchImpl(resource, { headers }), fetchImpl(`${resource}:getIamPolicy`, { headers })]);
  if (!service.ok || !policy.ok) {
    throw new Error(`the Cloud Run API answered HTTP ${service.ok ? policy.status : service.status} reading ${serviceName}`);
  }
  return exposure((await service.json()) as ServiceResource, (await policy.json()) as IamPolicy);
}
