import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";

async function anonymous(page: Page) {
  await page.route("**/api/backend/users/me", (route) =>
    route.fulfill({ status: 401, json: { message: "Sign in" } }),
  );
  await page.route("**/api/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: { message: "Sign in" } }),
  );
}
async function authenticated(page: Page) {
  await page.route("**/api/copilotkit", (route) =>
    route.fulfill({ json: { available: false } }),
  );
  await page.route("**/api/backend/users/me", (route) =>
    route.fulfill({
      json: {
        id: "test-user",
        name: "Test customer",
        phone: "+919876543210",
        isCustomer: true,
        isVendor: false,
      },
    }),
  );
  await page.route("**/api/auth/socket", (route) =>
    route.fulfill({ status: 401, json: { message: "No test WebSocket" } }),
  );
  await page.route("**/api/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: { message: "No test refresh" } }),
  );
}
test("landing links, honest demo, and mobile layout", async ({ page }) => {
  await anonymous(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Restaurant", exact: true }).click();
  await expect(
    page.getByText("Something delicious for dinner tonight? 🍛"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Salon", exact: true }).click();
  await expect(
    page.getByText("I’d love a haircut this weekend. 💇"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Photographer", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Try on Telegram" }),
  ).toHaveAttribute("href", "https://t.me/locogi_bot");
  await expect(
    page.getByRole("heading", {
      name: "ChatGPT for local services. Ask. Book. Done.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Locogi agent · Illustrative demo"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Find your something" }),
  ).toHaveAttribute("href", "/chat");
  await page.screenshot({
    path: "test-results/landing-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/landing-mobile.png",
    fullPage: true,
  });
});
test("phone login clearly says where the development OTP goes", async ({
  page,
}) => {
  await anonymous(page);
  await page.route("**/api/auth/request-otp", (route) =>
    route.fulfill({ json: { success: true } }),
  );
  await page.goto("/login");
  await expect(
    page.getByText("logged to the API console, not sent by SMS."),
  ).toBeVisible();
  await page.getByLabel("Phone number").fill("+919876543210");
  await page.getByRole("button", { name: "Send verification code" }).click();
  await expect(page.getByLabel("Verification code")).toBeVisible();
});
test("discovery shows empty search rather than invented businesses", async ({
  page,
}) => {
  await anonymous(page);
  await page.route("**/api/backend/search/catalog?**", (route) =>
    route.fulfill({ json: { results: [] } }),
  );
  await page.goto("/services?q=photographer");
  await expect(
    page.getByRole("heading", {
      name: "No businesses to show for this search.",
    }),
  ).toBeVisible();
});
test("API outage is finite and visible", async ({ page }) => {
  await anonymous(page);
  await page.route("**/api/backend/search/catalog?**", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "Locogi API is unavailable." },
    }),
  );
  await page.goto("/services?q=photographer");
  await expect(page.locator(".network-banner")).toBeVisible();
  await expect(page.locator(".error-box")).toContainText(
    "Locogi API is unavailable.",
  );
  await expect(page.locator(".loading-state")).toHaveCount(0);
});
test("registry refetches current bookings and suppresses unknown component types", async ({
  page,
}) => {
  await authenticated(page);
  await page.route("**/api/backend/chat/history", (route) =>
    route.fulfill({ json: { messages: [] } }),
  );
  await page.route("**/api/backend/categories/search?**", (route) =>
    route.fulfill({ json: { suggestions: [] } }),
  );
  await page.route("**/api/backend/bookings/booking-a", (route) =>
    route.fulfill({
      json: {
        id: "booking-a",
        title: "Current booking",
        status: "cancelled",
        price: 750,
        bookingType: "quote",
        canCancel: false,
        canTrack: false,
      },
    }),
  );
  let call = 0;
  await page.route("**/api/backend/chat", (route) =>
    route.fulfill({
      json:
        ++call === 1
          ? {
              message: "Your booking.",
              ui: {
                type: "booking_status",
                data: {
                  bookingId: "booking-a",
                  status: "CONFIRMED",
                  price: 987654,
                },
              },
            }
          : {
              message: "Plain response.",
              ui: {
                type: "unknown_malicious_component",
                data: { html: "<script>alert(1)</script>" },
              },
            },
    }),
  );
  await page.goto("/chat");
  const input = page.getByLabel("Message the agent");
  await input.fill("Where is my booking?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("Current booking", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".booking-card .status")).toHaveText("cancelled");
  await expect(page.getByText("987654")).toHaveCount(0);
  await input.fill("Continue");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Plain response.")).toBeVisible();
  await expect(page.locator(".server-card")).toHaveCount(1);
});
test("cancellation requires a separate explicit confirmation message", async ({
  page,
}) => {
  await authenticated(page);
  await page.route("**/api/backend/chat/history", (route) =>
    route.fulfill({ json: { messages: [] } }),
  );
  await page.route("**/api/backend/categories/search?**", (route) =>
    route.fulfill({ json: { suggestions: [] } }),
  );
  await page.route("**/api/backend/bookings/booking-a", (route) =>
    route.fulfill({
      json: {
        id: "booking-a",
        title: "Wedding booking",
        status: "confirmed",
        price: 750,
        bookingType: "quote",
        canCancel: true,
      },
    }),
  );
  await page.route("**/api/backend/chat/context", (route) =>
    route.fulfill({
      json: {
        context: {
          pendingConfirmation: {
            intent: "CANCEL_BOOKING",
            bookingId: "booking-a",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        },
      },
    }),
  );
  const messages: string[] = [];
  await page.route("**/api/backend/chat", (route) => {
    messages.push(route.request().postDataJSON().message);
    return route.fulfill({
      json:
        messages.length === 1
          ? {
              message: "Please confirm cancellation.",
              ui: { type: "confirm_action", data: { bookingId: "booking-a" } },
            }
          : { message: "Confirmation received by the test endpoint." },
    });
  });
  await page.goto("/chat");
  await page.getByLabel("Message the agent").fill("cancel it");
  await page.getByRole("button", { name: "Send message" }).click();
  const confirm = page.getByRole("button", { name: "Yes, confirm action" });
  await expect(confirm).toBeEnabled();
  expect(messages).toEqual(["cancel it"]);
  await confirm.click();
  await expect(
    page.getByText("Confirmation received by the test endpoint."),
  ).toBeVisible();
  expect(messages).toEqual(["cancel it", "yes"]);
  await expect(confirm).toBeDisabled();
});
test("dashboard requires a returned membership and honors staff UI restrictions", async ({
  page,
}) => {
  await authenticated(page);
  await page.route("**/api/backend/organizations/mine", (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            id: "org-a",
            display_name: "Test business",
            role: "staff",
            org_type: "salon",
          },
        ],
      },
    }),
  );
  await page.route("**/api/backend/organizations/org-a/catalog", (route) =>
    route.fulfill({ json: { sections: [] } }),
  );
  await page.goto("/dashboard/catalog");
  await expect(
    page.getByRole("heading", {
      name: "This page isn’t available to your role.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Analytics", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("WebSocket frames trigger REST reads, heartbeat, and resubscription without supplying state", async ({
  page,
}) => {
  await page.clock.install();
  await authenticated(page);
  await page.route("**/api/auth/socket", (route) =>
    route.fulfill({ json: { token: "test-socket-token" } }),
  );
  await page.route("**/api/backend/chat/history", (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            id: "history-a",
            role: "agent",
            text: "Your booking",
            ui: {
              type: "booking_status",
              data: { bookingId: "booking-a", price: 999999 },
            },
            timestamp: "2026-09-12T09:00:00Z",
          },
        ],
      },
    }),
  );
  let currentStatus = "confirmed";
  let reads = 0;
  await page.route("**/api/backend/bookings/booking-a", (route) => {
    reads += 1;
    return route.fulfill({
      json: {
        id: "booking-a",
        title: "Live booking",
        bookingType: "quote",
        price: 800,
        status: currentStatus,
        canCancel: false,
      },
    });
  });
  let connection: WebSocketRoute | undefined;
  let connections = 0;
  const actions: string[] = [];
  await page.routeWebSocket("ws://localhost:3001/ws**", (socket) => {
    connection = socket;
    connections += 1;
    expect(new URL(socket.url()).searchParams.get("token")).toBe(
      "test-socket-token",
    );
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      actions.push(message.action);
      if (message.action === "subscribe")
        socket.send(
          JSON.stringify({ type: "subscribed", topic: message.topic }),
        );
      if (message.action === "ping")
        socket.send(JSON.stringify({ type: "pong" }));
    });
  });
  await page.goto("/chat");
  await expect(page.locator(".booking-card .status")).toHaveText("confirmed");
  await expect
    .poll(() => actions.filter((action) => action === "subscribe").length)
    .toBe(1);
  const before = reads;
  currentStatus = "cancelled";
  connection!.send(
    JSON.stringify({
      type: "booking.changed",
      topic: { kind: "booking", id: "booking-a" },
      data: { status: "completed", price: 999999 },
    }),
  );
  await expect(page.locator(".booking-card .status")).toHaveText("cancelled");
  expect(reads).toBeGreaterThan(before);
  await expect(page.getByText("999999")).toHaveCount(0);
  await page.clock.fastForward(31000);
  await expect.poll(() => actions.includes("ping")).toBe(true);
  connection!.close({ code: 1000, reason: "Test reconnect" });
  await expect(page.locator(".chat-header")).toContainText("reconnecting");
  await page.clock.fastForward(5000);
  await expect.poll(() => connections).toBe(2);
  await expect
    .poll(() => actions.filter((action) => action === "subscribe").length)
    .toBe(2);
});
