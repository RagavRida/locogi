import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { vendorPermissions } from "../src/lib/vendor-permissions";
import type { Membership } from "../src/lib/contracts";
import { forwardCopilot } from "../src/lib/copilot-proxy";

const state = vi.hoisted(() => ({ allowed: true }));
vi.mock("../src/lib/workspace-server", () => ({
  membership: async () =>
    state.allowed
      ? { member: { id: "org-a", role: "owner" }, token: "local-api-secret" }
      : null,
}));
vi.mock("../src/lib/auth0", () => ({
  websiteToken: async () => "local-api-secret",
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  state.allowed = true;
});
it("restricts financial context and mutations by role", () => {
  const permissions = (role: Membership["role"]) =>
    vendorPermissions({
      id: "org-a",
      display_name: "Business",
      org_type: "salon",
      role,
    });
  expect(permissions("owner")).toMatchObject({
    viewRevenue: true,
    updateBookings: true,
    editCatalog: true,
  });
  expect(permissions("manager")).toMatchObject({
    viewRevenue: true,
    updateBookings: false,
    editCatalog: true,
    manageStaff: false,
  });
  for (const role of ["staff", "practitioner"] as const)
    expect(permissions(role)).toMatchObject({
      viewRevenue: false,
      updateBookings: false,
      editCatalog: false,
      assignedOnly: true,
    });
});
it("honors explicit permission overrides", () => {
  expect(
    vendorPermissions({
      id: "org-a",
      display_name: "Business",
      org_type: "salon",
      role: "manager",
      can_view_earnings: false,
    }).viewRevenue,
  ).toBe(false);
});
it("never forwards Locogi bearer credentials to Copilot Cloud", async () => {
  vi.stubEnv("NEXT_PUBLIC_COPILOT_CLOUD_PUBLIC_API_KEY", "test-public-key");
  vi.stubEnv("COPILOTKIT_URL", "");
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ agents: {} }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const result = await forwardCopilot(
    new NextRequest("http://localhost:3002/api/copilotkit/info", {
      headers: { "x-org-id": "org-a" },
    }),
    ["info"],
  );
  expect(result.status).toBe(200);
  expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  expect(fetch.mock.calls[0][1].headers["X-CopilotCloud-Public-Api-Key"]).toBe(
    "test-public-key",
  );
});
it("rejects nonmembers before contacting the AI runtime", async () => {
  state.allowed = false;
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const result = await forwardCopilot(
    new NextRequest("http://localhost:3002/api/copilotkit/info", {
      headers: { "x-org-id": "org-a" },
    }),
    ["info"],
  );
  expect(result.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
it("does not reflect runtime errors containing credentials", async () => {
  vi.stubEnv("NEXT_PUBLIC_COPILOT_CLOUD_PUBLIC_API_KEY", "test-public-key");
  vi.stubEnv("COPILOTKIT_URL", "");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("test-public-key", { status: 401 })),
  );
  const result = await forwardCopilot(
    new NextRequest("http://localhost:3002/api/copilotkit/info", {
      headers: { "x-org-id": "org-a" },
    }),
    ["info"],
  );
  expect(result.status).toBe(401);
  expect(await result.text()).not.toContain("test-public-key");
});
