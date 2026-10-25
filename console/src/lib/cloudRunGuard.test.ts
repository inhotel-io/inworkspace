import { describe, expect, it, vi } from "vitest";
import { exposure, readExposure } from "./cloudRunGuard";

describe("exposure", () => {
  it("reports a service anyone can invoke", () => {
    expect(exposure({}, { bindings: [{ role: "roles/run.invoker", members: ["user:alex@example.com", "allUsers"] }] })).toBe(
      "roles/run.invoker is granted to allUsers",
    );
    expect(exposure({}, { bindings: [{ role: "roles/run.invoker", members: ["allAuthenticatedUsers"] }] })).toBe(
      "roles/run.invoker is granted to allAuthenticatedUsers",
    );
    expect(exposure({ invokerIamDisabled: true }, {})).toBe("the service has its IAM invoker check disabled");
  });

  it("accepts a private service", () => {
    expect(
      exposure({ invokerIamDisabled: false }, {
        bindings: [
          { role: "roles/run.invoker", members: ["user:alex@example.com", "serviceAccount:x@p.iam.gserviceaccount.com"] },
          { role: "roles/run.viewer", members: ["allUsers"] },
        ],
      }),
    ).toBeNull();
    expect(exposure({}, {})).toBeNull();
  });
});

describe("readExposure", () => {
  it("reads the service and its policy through the metadata server's identity", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("project/project-id")) return new Response("proj");
      if (url.endsWith("instance/region")) return new Response("projects/123/regions/europe-west1");
      if (url.endsWith("service-accounts/default/token")) return Response.json({ access_token: "tok" });
      if (url.endsWith(":getIamPolicy")) return Response.json({ bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] });
      return Response.json({ invokerIamDisabled: false });
    });
    expect(await readExposure("console", fetchImpl)).toBe("roles/run.invoker is granted to allUsers");
    const urls = fetchImpl.mock.calls.map(([input]) => String(input));
    expect(urls).toContain("https://run.googleapis.com/v2/projects/proj/locations/europe-west1/services/console");
    expect(urls).toContain("https://run.googleapis.com/v2/projects/proj/locations/europe-west1/services/console:getIamPolicy");
    const metadataCall = fetchImpl.mock.calls.find(([input]) => String(input).endsWith("project/project-id"))!;
    expect(new Headers(metadataCall[1]!.headers).get("metadata-flavor")).toBe("Google");
    const apiCall = fetchImpl.mock.calls.find(([input]) => String(input).endsWith(":getIamPolicy"))!;
    expect(new Headers(apiCall[1]!.headers).get("authorization")).toBe("Bearer tok");
  });

  it("fails when the policy cannot be read, so the caller fails closed", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("project/project-id")) return new Response("proj");
      if (url.endsWith("instance/region")) return new Response("projects/123/regions/europe-west1");
      if (url.endsWith("service-accounts/default/token")) return Response.json({ access_token: "tok" });
      return new Response("forbidden", { status: 403 });
    });
    await expect(readExposure("console", fetchImpl)).rejects.toThrow("HTTP 403");
  });
});
