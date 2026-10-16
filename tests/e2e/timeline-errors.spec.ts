import { expect, test } from "@playwright/test";

test("shows timeline errors, retries, and marks cached history as outdated", async ({
  page,
}) => {
  await page.clock.install();
  let broken = true;
  await page.route("**/api/incidents/*/timeline?*", async (route) => {
    await route.fulfill(
      broken
        ? { status: 503, json: { message: "History temporarily unavailable" } }
        : {
            json: {
              items: [
                {
                  id: "history-test",
                  at: "2026-10-12T12:00:00Z",
                  actor: "test",
                  text: "Recovered history",
                  sequence: "1",
                },
              ],
              nextCursor: null,
            },
          },
    );
  });
  // Fixture isolates this UI failure scenario from the shared simulation used by other tests.
  await page.route("**/api/summary", (route) =>
    route.fulfill({
      json: {
        services: [],
        incidents: [
          {
            id: "INC-TIMELINE",
            title: "Timeline failure test",
            serviceId: "search",
            severity: "P1",
            status: "triggered",
            assignee: null,
            alerts: 1,
            version: 1,
            createdAt: "2026-10-12T12:00:00Z",
            resolvedAt: null,
          },
        ],
        resolvedCount: 0,
        rules: [],
        audit: [],
        eventCount: 1,
      },
    }),
  );
  await page.route("**/api/incidents/INC-TIMELINE?timeline=none", (route) =>
    route.fulfill({
      json: {
        id: "INC-TIMELINE",
        title: "Timeline failure test",
        serviceId: "search",
        severity: "P1",
        status: "triggered",
        assignee: null,
        alerts: 1,
        version: 1,
        createdAt: "2026-10-12T12:00:00Z",
        resolvedAt: null,
        timeline: [],
      },
    }),
  );
  await page.route("**/api/incidents?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "INC-TIMELINE",
            title: "Timeline failure test",
            serviceId: "search",
            severity: "P1",
            status: "triggered",
            assignee: null,
            alerts: 1,
            version: 1,
            createdAt: "2026-10-12T12:00:00Z",
            resolvedAt: null,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  // Keep AI panel quiet so its alerts do not collide with timeline history alerts.
  await page.route("**/api/incidents/*/analysis**", (route) =>
    route.fulfill({
      json: {
        enabled: false,
        reason: "AI disabled in timeline fixture",
        job: null,
      },
    }),
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Timeline failure test", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const historyAlert = dialog
    .getByRole("alert")
    .filter({ hasText: /Unable to load incident history|may be outdated/ });
  await expect(historyAlert).toContainText("Unable to load incident history");
  broken = false;
  await dialog.getByRole("button", { name: "Retry history" }).click();
  await expect(
    dialog.getByText("Recovered history", { exact: true }),
  ).toBeVisible();
  await expect(historyAlert).toHaveCount(0);
  broken = true;
  // Advance the real query timer rather than spending the test budget waiting
  // for its 15-second interval. Observe the failed request before checking UI.
  const failedRefresh = page.waitForResponse(
    (response) =>
      response.url().includes("/api/incidents/INC-TIMELINE/timeline?") &&
      response.status() === 503,
  );
  await page.clock.fastForward(15_001);
  await failedRefresh;
  await expect(historyAlert).toContainText("may be outdated");
  await expect(
    dialog.getByText("Recovered history", { exact: true }),
  ).toBeVisible();
});
