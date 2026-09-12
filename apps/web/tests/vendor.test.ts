import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("../src/lib/auth0", () => ({
  websiteToken: async (request: NextRequest) =>
    request.cookies.get("locogi_access")?.value || null,
}));
import { POST as onboard } from "../src/app/api/onboard/route";
import {
  GET,
  POST,
  PATCH,
} from "../src/app/api/business/[orgId]/[...path]/route";
import {
  forgetPlatformKey,
  platformKey,
  rememberPlatformKey,
} from "../src/lib/workspace-server";

function incoming(path: string, method = "GET", data?: unknown) {
  return new NextRequest(`http://localhost:3002/api/business/org-a/${path}`, {
    method,
    headers: {
      origin: "http://localhost:3002",
      cookie: "locogi_access=test-access",
      "Content-Type": "application/json",
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
const members = (role = "owner") =>
  response({ organizations: [{ id: "org-a", role }] });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  forgetPlatformKey("org-a");
});

it("forwards the business description to AI onboarding and retains the integration credential server-side", async () => {
  const fetch = vi.fn().mockResolvedValue(
    response({
      organizationId: "org-a",
      displayName: "Studio",
      apiKey: "private-integration-key",
      widgetCode: "private snippet",
      stats: { catalogItems: 4, resources: 2, slotsGenerated: 84 },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await onboard(
    incoming("onboard", "POST", {
      description: "A photography studio with two photographers.",
      city: "Hyderabad",
      role: "owner",
      userId: "forged",
    }),
  );
  expect(result.status).toBe(201);
  const body = await result.json();
  expect(body.stats).toEqual({
    catalogItems: 4,
    resources: 2,
    slotsGenerated: 84,
  });
  expect(JSON.stringify(body)).not.toContain("private");
  expect(platformKey("org-a")).toBe("private-integration-key");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    description: "A photography studio with two photographers.",
    city: "Hyderabad",
  });
});
it("does not call onboarding for an incomplete description", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(
    (await onboard(incoming("onboard", "POST", { description: "short" })))
      .status,
  ).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it("denies staff permission to create integration keys", async () => {
  const fetch = vi.fn().mockResolvedValue(members("staff"));
  vi.stubGlobal("fetch", fetch);
  expect(
    (
      await POST(incoming("connection", "POST", {}), {
        params: { orgId: "org-a", path: ["connection"] },
      })
    ).status,
  ).toBe(403);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("reads the current catalog with the server-held org key", async () => {
  rememberPlatformKey("org-a", "test-org-key");
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(members())
    .mockResolvedValueOnce(
      response({
        items: [
          {
            id: "item-a",
            name: "Full day",
            base_price: 25000,
            section: "Wedding",
            is_available: false,
          },
        ],
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const result = await GET(incoming("catalog"), {
    params: { orgId: "org-a", path: ["catalog"] },
  });
  expect((await result.json()).sections.Wedding[0]).toMatchObject({
    price: 25000,
    isAvailable: false,
  });
  expect(fetch.mock.calls[1][1].headers["x-api-key"]).toBe("test-org-key");
});
it("refuses a forged booking id without calling the unscoped mutation route", async () => {
  rememberPlatformKey("org-a", "test-org-key");
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(members())
    .mockResolvedValueOnce(response({ bookings: [{ id: "owned" }] }));
  vi.stubGlobal("fetch", fetch);
  expect(
    (
      await PATCH(
        incoming("bookings/foreign", "PATCH", { status: "cancelled" }),
        { params: { orgId: "org-a", path: ["bookings", "foreign"] } },
      )
    ).status,
  ).toBe(404);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("sends only an explicitly requested status after verifying organization ownership", async () => {
  rememberPlatformKey("org-a", "test-org-key");
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(members())
    .mockResolvedValueOnce(response({ bookings: [{ id: "owned" }] }))
    .mockResolvedValueOnce(response({ success: true }));
  vi.stubGlobal("fetch", fetch);
  const result = await PATCH(
    incoming("bookings/owned", "PATCH", {
      status: "confirmed",
      agreedPrice: 1,
      userId: "forged",
    }),
    { params: { orgId: "org-a", path: ["bookings", "owned"] } },
  );
  expect(result.status).toBe(200);
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({
    status: "confirmed",
  });
});
it("does not let staff cancel bookings", async () => {
  rememberPlatformKey("org-a", "test-org-key");
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(members("staff"))
    .mockResolvedValueOnce(response({ bookings: [{ id: "owned" }] }));
  vi.stubGlobal("fetch", fetch);
  expect(
    (
      await PATCH(
        incoming("bookings/owned", "PATCH", { status: "cancelled" }),
        { params: { orgId: "org-a", path: ["bookings", "owned"] } },
      )
    ).status,
  ).toBe(403);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("fails closed when practitioner-scoped reads are unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(members("practitioner")));
  expect(
    (
      await GET(incoming("bookings"), {
        params: { orgId: "org-a", path: ["bookings"] },
      })
    ).status,
  ).toBe(501);
});
