import { test, expect, type Page } from "@playwright/test";

async function session(page: Page) {
  await page.route("**/api/backend/users/me", (route) =>
    route.fulfill({
      json: {
        id: "user-a",
        name: "Studio owner",
        phone: "+919876543210",
        isVendor: true,
        isCustomer: true,
      },
    }),
  );
  await page.route("**/api/auth/socket", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/api/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/api/copilotkit", (route) =>
    route.fulfill({ json: { available: false } }),
  );
  await page.route("**/api/backend/organizations/mine", (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            id: "org-a",
            display_name: "Test studio",
            role: "owner",
            org_type: "photography",
          },
        ],
      },
    }),
  );
}
test("AI onboarding submits once and displays the server's actual counts", async ({
  page,
}) => {
  await session(page);
  let calls = 0;
  await page.route("**/api/onboard", async (route) => {
    calls += 1;
    expect(route.request().postDataJSON().description).toContain("photography");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      json: {
        organizationId: "org-a",
        displayName: "Test studio",
        stats: { catalogItems: 7, resources: 3, slotsGenerated: 42 },
        platformConnected: true,
      },
    });
  });
  await page.goto("/onboard");
  await page
    .getByLabel("Describe your business")
    .fill("I run a photography studio in Hyderabad with three photographers.");
  await page
    .getByRole("button", { name: "Create my business with AI" })
    .click();
  await expect(
    page.getByText("AI is setting up your business…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Test studio" }),
  ).toBeVisible();
  await expect(page.locator(".onboard-results")).toContainText("7");
  await expect(page.locator(".onboard-results")).toContainText("42");
  await expect(
    page.getByRole("link", { name: "Go to Dashboard" }),
  ).toHaveAttribute("href", "/dashboard?orgId=org-a");
  expect(calls).toBe(1);
  await page.screenshot({
    path: "test-results/onboard-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("owner edits catalog and availability through the platform API", async ({
  page,
}) => {
  await session(page);
  let price = 25000;
  let available = true;
  const writes: unknown[] = [];
  await page.route("**/api/business/org-a/catalog", (route) => {
    if (route.request().method() === "POST") {
      const item = route.request().postDataJSON().items[0];
      writes.push(item);
      price = item.price;
      available = item.isAvailable;
      return route.fulfill({ json: { updated: 1 } });
    }
    return route.fulfill({
      json: {
        sections: {
          Wedding: [
            {
              id: "item-a",
              name: "Full day",
              section: "Wedding",
              price,
              isAvailable: available,
            },
          ],
        },
      },
    });
  });
  await page.goto("/dashboard/catalog");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Price (API units)").fill("35000");
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(page.getByText("Catalog item saved by the API.")).toBeVisible();
  await expect(page.locator(".managed-item")).toContainText("35,000");
  await page.getByRole("button", { name: "Pause item" }).click();
  await expect(
    page.getByRole("button", { name: "Make available" }),
  ).toBeVisible();
  expect(writes).toHaveLength(2);
  await expect(page.getByTestId("vendor-copilot")).toBeAttached();
  await page.screenshot({
    path: "test-results/vendor-catalog.png",
    fullPage: true,
  });
});
