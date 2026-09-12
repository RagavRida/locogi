import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/backend/users/me", (route) =>
    route.fulfill({ status: 401, json: { message: "Sign in" } }),
  );
  await page.route("**/api/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: { message: "Sign in" } }),
  );
});

test("capsule navbar is centered, bounded, and tightens on scroll", async ({
  page,
}) => {
  await page.goto("/");
  const header = page.locator(".site-header");
  await expect(header).toHaveCSS("position", "fixed");
  await expect(header).toHaveCSS("border-radius", "999px");
  await expect(header).toHaveCSS("padding", "8px 24px");
  await expect(header).toHaveCSS("backdrop-filter", "blur(20px)");
  await expect(header).toHaveCSS("background-color", "rgba(18, 18, 30, 0.85)");
  await expect(header).toHaveCSS("z-index", "1000");
  await expect(header.locator("nav")).toHaveCSS("column-gap", "8px");
  const initial = (await header.boundingBox())!;
  expect(initial.width).toBeLessThanOrEqual(700);
  expect(
    Math.abs(initial.x + initial.width / 2 - page.viewportSize()!.width / 2),
  ).toBeLessThan(1);
  expect(initial.y).toBe(16);
  const cta = header.getByRole("link", { name: "Let’s chat" });
  await expect(cta).toHaveCSS("border-radius", "999px");
  expect(
    await cta.evaluate((element) => getComputedStyle(element).backgroundImage),
  ).toContain("linear-gradient");
  await page.screenshot({ path: "test-results/navbar-desktop.png" });
  await page.mouse.wheel(0, 600);
  await expect(header).toHaveClass(/is-scrolled/);
  await expect(header).toHaveCSS("padding", "6px 20px");
  await expect(header).toHaveCSS("backdrop-filter", "blur(28px)");
  const scrolled = (await header.boundingBox())!;
  expect(scrolled.y).toBe(16);
  expect(scrolled.height).toBeLessThan(initial.height);
  await page.screenshot({ path: "test-results/navbar-scrolled.png" });
});

test("active pills and mobile navigation remain usable", async ({ page }) => {
  await page.goto("/services");
  const header = page.locator(".site-header");
  const active = header.getByRole("link", {
    name: "Explore services",
    exact: true,
  });
  await expect(active).toHaveAttribute("aria-current", "page");
  await expect(active).toHaveCSS(
    "background-color",
    "rgba(99, 102, 241, 0.15)",
  );
  await active.hover();
  expect(
    await active.evaluate((element) => getComputedStyle(element).textShadow),
  ).not.toBe("none");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(header).toHaveCSS("padding", "8px 10px");
    const bounds = (await header.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(15);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 15);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await header.getByRole("link", { name: "For businesses" }).focus();
    await expect(
      header.getByRole("link", { name: "For businesses" }),
    ).toBeFocused();
    await expect(
      header.getByRole("link", { name: "Let’s chat" }),
    ).toBeVisible();
    const nav = (await header.locator("nav").boundingBox())!;
    for (const label of ["Explore services", "My bookings", "For businesses"]) {
      const link = (await header
        .getByRole("link", { name: label, exact: true })
        .boundingBox())!;
      expect(link.x).toBeGreaterThanOrEqual(nav.x - 1);
      expect(link.x + link.width).toBeLessThanOrEqual(nav.x + nav.width + 1);
    }
  }
  await page.screenshot({ path: "test-results/navbar-mobile.png" });
});

test("the floating navbar does not cover API error controls", async ({
  page,
}) => {
  await page.route("**/api/backend/users/me", (route) =>
    route.fulfill({ status: 503, json: { message: "API unavailable" } }),
  );
  await page.goto("/");
  const retry = page.getByRole("button", { name: "Retry connection" });
  await expect(retry).toBeVisible();
  const header = (await page.locator(".site-header").boundingBox())!;
  const button = (await retry.boundingBox())!;
  expect(button.y).toBeGreaterThan(header.y + header.height);
});
