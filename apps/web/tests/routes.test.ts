import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/backend/[...path]/route";
import { POST as auth } from "../src/app/api/session/[action]/route";
import { GET as workspace } from "../src/app/api/workspace/[orgId]/[resource]/route";
import { catalogSections, money, safeImage } from "../src/lib/contracts";

vi.mock("../src/lib/auth0", () => ({
  websiteToken: async (request: NextRequest) =>
    request.cookies.get("locogi_access")?.value || null,
  websiteSession: async () => ({
    user: { sub: "auth0|test-user" },
    locogiUserId: "test-user",
    locogiReturnTo: "/chat",
  }),
  safeReturnTo: (value: string) => value || "/chat",
  auth0: () => ({
    getAccessToken: async () => ({ accessToken: "auth0-api-token" }),
    getSession: async () => ({ user: { sub: "auth0|test-user" } }),
    updateSession: vi.fn(),
  }),
}));

function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = "locogi_access=test-access",
) {
  return new NextRequest(`http://localhost:3002/api/backend/${path}`, {
    method,
    headers: {
      origin: "http://localhost:3002",
      cookie,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": "test-correlation",
    },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Backend-for-frontend boundaries", () => {
  it("refuses anonymous booking reads before reaching the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await GET(request("bookings", "GET", undefined, ""), {
      params: { path: ["bookings"] },
    });
    expect(result.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects paths outside the closed route list", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await GET(request("platform/api-keys"), {
      params: { path: ["platform", "api-keys"] },
    });
    expect(result.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses cross-origin mutations", async () => {
    const incoming = new NextRequest("http://localhost:3002/api/backend/chat", {
      method: "POST",
      headers: {
        origin: "https://untrusted.example",
        cookie: "locogi_access=test-access",
      },
      body: JSON.stringify({ message: "yes" }),
    });
    const result = await POST(incoming, { params: { path: ["chat"] } });
    expect(result.status).toBe(403);
  });
  it("uses the prefixed backend and projects chat identity from the token", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ message: "Hello" }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("API_URL", "http://localhost:3001");
    vi.stubEnv("API_CHAT_FIELD", "text");
    const result = await POST(
      request("chat", "POST", {
        message: "Hello",
        userId: "someone-else",
        role: "owner",
        sessionId: "foreign-session",
      }),
      { params: { path: ["chat"] } },
    );
    expect(fetch.mock.calls[0][0]).toBe("http://localhost:3001/api/v1/chat");
    const options = fetch.mock.calls[0][1];
    expect(JSON.parse(options.body)).toEqual({ text: "Hello" });
    expect(options.headers.Authorization).toBe("Bearer test-access");
    expect(result.headers.get("x-correlation-id")).toBe("test-correlation");
  });
  it("supports the described message contract through explicit server config", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ message: "Hello" }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("API_CHAT_FIELD", "message");
    await POST(request("chat", "POST", { message: "Hello", orgId: "org-a" }), {
      params: { path: ["chat"] },
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      message: "Hello",
      orgId: "org-a",
    });
  });
  it("does not allow a staff member to write the catalog", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json({ organizations: [{ id: "org-a", role: "staff" }] }),
      );
    vi.stubGlobal("fetch", fetch);
    const result = await POST(
      request("organizations/org-a/catalog", "POST", { items: [] }),
      { params: { path: ["organizations", "org-a", "catalog"] } },
    );
    expect(result.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("denies another organization even on a read", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json({ organizations: [{ id: "org-a", role: "owner" }] }),
      );
    vi.stubGlobal("fetch", fetch);
    const result = await GET(request("organizations/org-b/catalog"), {
      params: { path: ["organizations", "org-b", "catalog"] },
    });
    expect(result.status).toBe(403);
  });
  it("returns a finite, credential-free unavailable response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("secret upstream URL")),
    );
    const result = await GET(request("bookings"), {
      params: { path: ["bookings"] },
    });
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("secret");
  });
  it("keeps an empty category response empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ suggestions: [] })),
    );
    const result = await GET(request("categories/search?q=sink"), {
      params: { path: ["categories", "search"] },
    });
    expect(await result.json()).toEqual({ suggestions: [] });
  });
  it("never substitutes customer bookings for a missing vendor endpoint", async () => {
    vi.stubEnv("API_VENDOR_BOOKINGS_PATH", "");
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json({ organizations: [{ id: "org-a", role: "owner" }] }),
      );
    vi.stubGlobal("fetch", fetch);
    const result = await workspace(request("workspace"), {
      params: { orgId: "org-a", resource: "bookings" },
    });
    expect(result.status).toBe(428);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("adapts the checkout's category-search envelope without inventing suggestions", async () => {
  const fetch = vi.fn().mockResolvedValue(
    json({
      results: [
        {
          id: "category-a",
          content: "Photography",
          metadata: { canonical_name: "Photography" },
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("API_CATEGORY_SEARCH_PATH", "/search/categories");
  const result = await GET(request("categories/search?q=photo"), {
    params: { path: ["categories", "search"] },
  });
  expect(fetch.mock.calls[0][0]).toContain("/api/v1/search/categories?q=photo");
  expect(await result.json()).toEqual({
    suggestions: [{ id: "category-a", name: "Photography" }],
  });
});

describe("Authentication cookies", () => {
  it("never returns JWTs in the login response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          accessToken: "private-access",
          refreshToken: "private-refresh",
          userId: "test-user",
        }),
      ),
    );
    const result = await auth(request("session/exchange", "POST", {}, ""), {
      params: { action: "exchange" },
    });
    expect(await result.json()).toEqual({ success: true, returnTo: "/chat" });
    expect(result.cookies.get("locogi_access")?.value).toBe("private-access");
    const cookies = result.headers.get("set-cookie") || "";
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("SameSite=lax");
    expect(cookies).toContain("Max-Age=2592000");
  });
  it("refreshes with the HTTP-only cookie, not a client-supplied token", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json({
          accessToken: `e30.${Buffer.from(JSON.stringify({ sub: "test-user" })).toString("base64url")}.signature`,
          refreshToken: "new-refresh",
        }),
      );
    vi.stubGlobal("fetch", fetch);
    await auth(
      request(
        "auth/refresh",
        "POST",
        { refreshToken: "injected" },
        "locogi_refresh=owned-refresh",
      ),
      { params: { action: "refresh" } },
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      refreshToken: "owned-refresh",
    });
  });
  it("clears both cookies on sign-out", async () => {
    const result = await auth(request("auth/logout", "POST", {}), {
      params: { action: "logout" },
    });
    expect(result.cookies.get("locogi_access")?.value).toBe("");
    expect(result.cookies.get("locogi_refresh")?.value).toBe("");
  });
});

describe("Contract adapters", () => {
  it("supports both catalog section envelopes without ranking or computing prices", () => {
    const item = { id: "item-a", name: "Package", price: 1200 };
    expect(catalogSections({ sections: { Wedding: [item] } })).toEqual([
      { name: "Wedding", items: [item] },
    ]);
    expect(
      catalogSections({ sections: [{ name: "Wedding", items: [item] }] }),
    ).toEqual([{ name: "Wedding", items: [item] }]);
  });
  it("does not invent a price for missing data", () => {
    expect(money(null)).toBe("Price not supplied");
    expect(money(undefined)).toBe("Price not supplied");
  });
  it("does not allow script URLs as imagery", () => {
    expect(safeImage("javascript:alert(1)")).toBeUndefined();
    expect(safeImage("https://example.com/photo.jpg")).toBe(
      "https://example.com/photo.jpg",
    );
  });
});
