import { test, expect } from "@playwright/test";
import { fixtureAnalysis } from "../support/ai-fixture";
import type { AnalysisJob } from "../../shared/ai";
import { randomUUID } from "node:crypto";

test("shows evidence, stale analysis and downloads a postmortem draft without executing model text", async ({
  page,
}) => {
  let job: AnalysisJob | null = null;
  let stale = false;
  await page.route("**/api/incidents/*/analysis", async (route) => {
    if (route.request().method() === "POST") {
      const id = route.request().url().split("/incidents/")[1]!.split("/")[0]!;
      const context = {
        incidentId: id,
        incidentVersion: route.request().postDataJSON().version,
        sources: [
          {
            id: `incident:${id}`,
            kind: "incident" as const,
            label: id,
            text: "<script>window.AI_EXECUTED=true</script>",
          },
        ],
        limitations: ["Нет логов приложения"],
      };
      const result = fixtureAnalysis(context).result;
      result.summary.sources = [context.sources[0]!.id, "event:gone"];
      job = {
        id: "11111111-1111-4111-8111-111111111111",
        incidentId: id,
        incidentVersion: context.incidentVersion,
        state: "succeeded",
        model: "test-model",
        promptVersion: "test",
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        stale: false,
        contextRetained: true,
        attempts: 1,
        error: null,
        result,
        sources: context.sources,
        limitations: context.limitations,
        inputTokens: 100,
        outputTokens: 80,
        estimatedCostUsd: 0.000168,
        durationMs: 150,
      };
      await route.fulfill({ json: job });
    } else
      await route.fulfill({
        json: {
          enabled: true,
          reason: null,
          job: job ? { ...job, stale } : null,
        },
      });
  });
  await page.goto("/");
  const rule = await page.request.post("/api/rules", {
    data: {
      serviceId: "users",
      metric: "latency",
      threshold: 10,
      severity: "P2",
      enabled: true,
    },
  });
  expect(rule.ok()).toBe(true);
  const event = await page.request.post("/api/events", {
    data: {
      id: randomUUID(),
      source: "users",
      type: "latency",
      value: 20,
      timestamp: new Date().toISOString(),
    },
  });
  expect(event.ok()).toBe(true);
  await page
    .getByRole("button", { name: "Users service degradation", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "AI-помощник инцидента" });
  await panel
    .getByRole("button", { name: "Проанализировать", exact: true })
    .click();
  await expect(
    panel.getByRole("heading", { name: "Сводка", exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("[удалён]").first()).toBeVisible();
  await panel
    .getByRole("link", { name: "Источник 1", exact: true })
    .first()
    .click();
  await expect(panel.locator("details[open] pre")).toContainText("<script>");
  expect(await page.evaluate(() => Object.hasOwn(window, "AI_EXECUTED"))).toBe(
    false,
  );
  await panel
    .getByRole("button", { name: "Черновик postmortem", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Скачать черновик .md" }).click();
  expect((await download).suggestedFilename()).toContain("postmortem-draft.md");
  stale = true;
  await page.getByLabel("Add an update").fill("New evidence after analysis");
  await page.getByRole("button", { name: "Post update" }).click();
  await expect(panel.getByText(/Данные изменились/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("dialog").evaluate((element) => {
    element.scrollTop = 0;
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/ai-mobile.png" });
});

test("offers a replacement for an old result and for one whose sources were retained", async ({
  page,
}) => {
  const retained = {
    incidentId: "pending",
    incidentVersion: 1,
    sources: [
      {
        id: "incident:1",
        kind: "incident" as const,
        label: "incident",
        text: "alert",
      },
    ],
    limitations: ["Контекст удалён политикой хранения."],
  };
  const result = fixtureAnalysis(retained).result;
  await page.route("**/api/incidents/*/analysis", async (route) => {
    const id = route.request().url().split("/incidents/")[1]!.split("/")[0]!;
    const shared = {
      id: "22222222-2222-4222-8222-222222222222",
      incidentId: id,
      incidentVersion: 1,
      model: "test-model",
      promptVersion: "incident-v3",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      stale: false,
      attempts: 1,
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: null,
      durationMs: 1,
      sources: retained.sources,
      limitations: retained.limitations,
    };
    if (route.request().method() === "POST") {
      await route.fulfill({
        json: {
          ...shared,
          state: "succeeded",
          contextRetained: false,
          error: null,
          result,
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        enabled: true,
        reason: null,
        job: {
          ...shared,
          state: "incompatible",
          contextRetained: true,
          result: null,
          error: "Сохранённый анализ записан в предыдущем формате.",
        },
      },
    });
  });
  await page.goto("/");
  const rule = await page.request.post("/api/rules", {
    data: {
      serviceId: "payments",
      metric: "latency",
      threshold: 10,
      severity: "P2",
      enabled: true,
    },
  });
  expect(rule.ok()).toBe(true);
  const created = await page.request.post("/api/events", {
    data: {
      id: randomUUID(),
      source: "payments",
      type: "latency",
      value: 20,
      timestamp: new Date().toISOString(),
    },
  });
  expect(created.ok()).toBe(true);
  await page
    .getByRole("button", { name: "Payments service degradation", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "AI-помощник инцидента" });
  await expect(
    panel.getByText("Сохранённый анализ записан в предыдущем формате."),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Повторить анализ", exact: true })
    .click();
  await expect(
    panel.getByText("Источники удалены политикой хранения."),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Обновить анализ", exact: true }),
  ).toBeVisible();
});
