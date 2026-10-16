import { test, expect } from "@playwright/test";
test("simulates a correlated incident, assigns, comments and resolves", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("All systems operational")).toBeVisible();
  const simulationResponse = page.waitForResponse((r) =>
    r.url().endsWith("/api/simulations"),
  );
  await page
    .getByRole("button", { name: "Simulate incident", exact: true })
    .click();
  const response = await simulationResponse;
  expect(response.status(), await response.text()).toBe(202);
  await page
    .getByRole("button", { name: "Search service degradation", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Alert correlated: error_rate = 12.8"),
  ).toBeVisible();
  await expect(page.getByText("All systems operational")).toBeVisible({
    timeout: 20000,
  });
  await dialog.getByRole("button", { name: "Assign to me" }).click();
  await expect(dialog.getByText("Assigned to Local operator")).toBeVisible();
  await dialog
    .getByRole("button", { name: "Acknowledge", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Investigate", exact: true })
    .click();
  await dialog
    .getByLabel("Add an update")
    .fill("Investigated upstream latency.");
  await dialog.getByRole("button", { name: "Post update" }).click();
  await expect(
    dialog.getByText("Investigated upstream latency."),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Resolve incident", exact: true })
    .click();
  await expect(dialog.getByText("Resolved", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Alert rules", exact: true }).click();
  await page.getByRole("button", { name: "Create rule", exact: true }).click();
  await page.getByLabel("Greater than").fill("100");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create rule", exact: true })
    .click();
  await expect(
    page.getByText("API Gateway · Elevated error rate"),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/rules.png", fullPage: true });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.screenshot({ path: "test-results/overview.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "System overview" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
});

test("returns keyboard focus when the rule dialog closes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Alert rules", exact: true }).click();
  const open = page.getByRole("button", { name: "Create rule", exact: true });
  await open.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close rule dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeFocused();
});
