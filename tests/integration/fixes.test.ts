import { randomUUID } from "node:crypto";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { expect, it, vi } from "vitest";
import { AiService } from "../../server/ai/service";
import { runbookTick, startRun } from "../../server/operations/runbooks";
import { processDelivery } from "../../server/broker/rabbit-consume";
import { collectContext } from "../../server/ai/context";
import { readTimelineEntries } from "../../server/db/incident-timeline";
import { retain } from "../../server/operations/retention";
import { rabbitNamespaceResources } from "../support/rabbit-namespace";
import { fixtureAnalysis } from "../support/ai-fixture";
import { createIsolated, withCleanup } from "../support/isolated-infra";
import { event } from "./helpers";

it("names both classic and v2 queues for one test namespace", () => {
  const names = rabbitNamespaceResources("sentinel_e2e_abc");
  expect(names.queues).toContain("sentinel_e2e_abc.events.process.v2");
  expect(names.queues).toContain("sentinel_e2e_abc.events.process");
  expect(names.queues).toContain("sentinel_e2e_abc.ai.analysis.v1");
});

it("keeps delivery attempts after processDelivery fails mid-apply", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      const original = f.direct.transaction.bind(f.direct);
      let txn = 0;
      const spy = vi
        .spyOn(f.direct, "transaction")
        .mockImplementation(async (fn) => {
          txn += 1;
          if (txn === 2) throw new Error("apply failed after begin");
          return original(fn);
        });
      await expect(f.direct.processDelivery(input.id, 0)).rejects.toThrow(
        /apply failed/,
      );
      spy.mockRestore();
      const after = (
        await f.direct.pool.query<{ attempts: number }>(
          "SELECT attempts FROM monitoring_events WHERE id=$1",
          [input.id],
        )
      ).rows[0]!;
      expect(after.attempts).toBe(1);
      expect(await f.direct.processEvent(input.id)).not.toEqual({
        duplicate: true,
      });
    },
    () => f.dispose(),
  );
});

it("ignores a legacy status-only message for a replayed generation", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.terminalDelivery(input.id, 0, "old failure");
      await f.direct.replay(input.id, 0, "review", "dependency fixed");
      const channel = {
        ack: vi.fn(),
        nack: vi.fn(),
      } as unknown as ConfirmChannel;
      const message = {
        content: Buffer.from(JSON.stringify({ eventId: input.id })),
        properties: {
          headers: {
            "x-generation": 0,
            "x-status-only": 1,
            "x-retry-count": 4,
          },
        },
      } as unknown as ConsumeMessage;
      await processDelivery(channel, message, {
        store: f.direct,
        deadExchange: "unused",
        retryQueue: "unused",
        report: () => undefined,
        onChange: async () => undefined,
        confirm: async () => undefined,
        durableBudget: true,
      });
      const row = (
        await f.direct.pool.query<{
          failure: string | null;
          generation: number;
          terminal_at: Date | null;
        }>(
          "SELECT failure,generation,terminal_at FROM monitoring_events WHERE id=$1",
          [input.id],
        )
      ).rows[0]!;
      expect(row).toMatchObject({
        failure: null,
        generation: 1,
        terminal_at: null,
      });
      expect(await f.direct.beginDelivery(input.id, 1)).toBe(true);
      expect(await f.direct.processEvent(input.id)).not.toEqual({
        duplicate: true,
      });
    },
    () => f.dispose(),
  );
});

it("records the closed window aggregate instead of the recovery sample", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      for (const rule of (await f.direct.snapshot()).rules)
        await f.direct.toggleRule(rule.id, false);
      await f.direct.addRule({
        serviceId: "search-api",
        metric: "latency",
        threshold: 100,
        severity: "P2",
        enabled: true,
        windowSeconds: 60,
        allowedLatenessSeconds: 0,
        minSamples: 2,
        aggregation: "all",
      });
      const base = Math.floor((Date.now() - 120000) / 60000) * 60000;
      for (const [delta, value] of [
        [1000, 200],
        [30000, 300],
        [61000, 10],
      ] as const) {
        const input = event({
          type: "latency",
          value,
          timestamp: new Date(base + delta).toISOString(),
        });
        await f.direct.accept(input);
        await f.direct.processEvent(input.id);
      }
      const incident = (await f.direct.snapshot()).incidents[0]!;
      expect(incident.timeline).toEqual([]);
      const timeline = await readTimelineEntries(f.direct.pool, incident.id);
      expect(
        timeline.some((entry) => entry.text.includes("latency = 10")),
      ).toBe(false);
      expect(
        timeline.some(
          (entry) =>
            entry.text.includes("latency all=200") &&
            entry.text.includes("samples=2"),
        ),
      ).toBe(true);
      const linked = await f.direct.pool.query<{ value: number }>(
        "SELECT payload->>'value' AS value FROM monitoring_events WHERE incident_id=$1",
        [incident.id],
      );
      expect(
        linked.rows.map((row) => Number(row.value)).sort((a, b) => a - b),
      ).toEqual([200, 300]);
      const context = await f.direct.transaction((client) =>
        collectContext(client, incident.id),
      );
      expect(
        context.sources.some(
          (source) =>
            source.label.startsWith("срабатывание окна") &&
            source.text.includes('"serviceId":"search-api"') &&
            source.text.includes('"value":200'),
        ),
      ).toBe(true);
      expect(
        context.sources.some(
          (source) =>
            source.kind === "event" &&
            source.label.startsWith("событие инцидента") &&
            source.text.includes('"value":10'),
        ),
      ).toBe(false);
    },
    () => f.dispose(),
  );
});

it("returns an old AI result as incompatible and accepts a replacement", async () => {
  const f = await createIsolated();
  f.config.ai = { enabled: true, model: "test", dailyLimit: 50 };
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      const ai = new AiService(f.direct, f.config.ai, async (context) =>
        fixtureAnalysis(context),
      );
      const job = await ai.request(incident.id, incident.version, "review");
      await ai.process(job.id);
      await f.direct.pool.query(
        `UPDATE ai_analyses SET result=jsonb_set(jsonb_set(result,'{postmortem,rootCause}','"Причина не подтверждена"'::jsonb),'{postmortem,prevention}','["Добавить логи"]'::jsonb) WHERE id=$1`,
        [job.id],
      );
      const { app } = await f.startApi();
      const response = await app.inject(
        `/api/incidents/${incident.id}/analysis`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        enabled: true,
        job: { state: "incompatible", result: null },
      });
      const created = await app.inject({
        method: "POST",
        url: `/api/incidents/${incident.id}/analysis`,
        payload: { version: incident.version },
      });
      expect(created.statusCode).toBe(202);
      expect(created.json().id).not.toBe(job.id);
    },
    () => f.dispose(),
  );
});

it("drops a retained analysis from the reusable cache without calling it stale", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      await f.direct.pool.query(
        "UPDATE monitoring_events SET processed_at=now()-interval '20 days' WHERE id=$1",
        [input.id],
      );
      await f.direct.transaction((client) =>
        retain(client, 7, false, "review"),
      );
      const ai = new AiService(
        f.direct,
        { enabled: true, model: "test", dailyLimit: 50 },
        async (context) => fixtureAnalysis(context),
      );
      const job = await ai.request(incident.id, incident.version, "review");
      await ai.process(job.id);
      await f.direct.pool.query(
        "UPDATE ai_analyses SET completed_at=now()-interval '10 days' WHERE id=$1",
        [job.id],
      );
      const plan = await f.direct.transaction((client) =>
        retain(client, 7, true, "review"),
      );
      expect(plan.analyses).toBe(1);
      expect(plan).toEqual(
        expect.objectContaining({
          events: expect.any(Number),
          samples: expect.any(Number),
          timelines: expect.any(Number),
          ruleMatches: expect.any(Number),
          audit: expect.any(Number),
          runs: expect.any(Number),
          notifications: expect.any(Number),
          deadLetters: expect.any(Number),
        }),
      );
      await f.direct.transaction((client) =>
        retain(client, 7, false, "review"),
      );
      const status = await ai.status(incident.id);
      expect(status.job).toMatchObject({
        id: job.id,
        state: "succeeded",
        stale: false,
        contextRetained: false,
      });
      expect(
        (await ai.request(incident.id, incident.version, "review")).id,
      ).not.toBe(job.id);
    },
    () => f.dispose(),
  );
});

it("reports AI down while the event API stays ready without an AI consumer", async () => {
  const f = await createIsolated();
  f.config.ai = { enabled: true, model: "test-model", dailyLimit: 50 };
  await withCleanup(
    async () => {
      const { app, api } = await f.startApi();
      f.config.ai = { enabled: false, model: "test-model", dailyLimit: 50 };
      await f.startWorker();
      const queue = await api.rabbit.channel!.checkQueue(
        `${f.name}.ai.analysis.v1`,
      );
      expect(queue.consumerCount).toBe(0);
      const health = await app.inject("/api/health");
      expect(health.statusCode).toBe(200);
      expect(health.json().ai).toMatchObject({
        status: "down",
        connected: true,
        consumers: 0,
      });
    },
    () => f.dispose(),
  );
});

it("allocates a real incident id and a notification when point and window rules fire together", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      for (const rule of (await f.direct.snapshot()).rules)
        await f.direct.toggleRule(rule.id, false);
      await f.direct.addRule({
        serviceId: "search-api",
        metric: "latency",
        threshold: 1000,
        severity: "P1",
        enabled: true,
        allowedLatenessSeconds: 0,
      });
      await f.direct.addRule({
        serviceId: "search-api",
        metric: "latency",
        threshold: 100,
        severity: "P2",
        enabled: true,
        windowSeconds: 60,
        allowedLatenessSeconds: 0,
        minSamples: 2,
        aggregation: "all",
      });
      const base = Math.floor((Date.now() - 120000) / 60000) * 60000;
      for (const [delta, value] of [
        [1000, 200],
        [30000, 300],
        [61000, 1500],
      ] as const) {
        const input = event({
          type: "latency",
          value,
          timestamp: new Date(base + delta).toISOString(),
        });
        await f.direct.accept(input);
        await f.direct.processEvent(input.id);
      }
      const incident = (await f.direct.snapshot()).incidents[0]!;
      expect(incident.id).toMatch(/^INC-/);
      expect(incident.alerts).toBe(2);
      expect(
        (
          await f.direct.pool.query(
            "SELECT id FROM notification_jobs WHERE incident_id=$1",
            [incident.id],
          )
        ).rowCount,
      ).toBe(1);
    },
    () => f.dispose(),
  );
});

it("keeps at most twenty measurement ids for a large closed window", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      for (const rule of (await f.direct.snapshot()).rules)
        await f.direct.toggleRule(rule.id, false);
      await f.direct.addRule({
        serviceId: "search-api",
        metric: "latency",
        threshold: 100,
        severity: "P2",
        enabled: true,
        windowSeconds: 60,
        allowedLatenessSeconds: 0,
        minSamples: 2,
        aggregation: "max",
      });
      const base = Math.floor((Date.now() - 120000) / 60000) * 60000;
      for (let index = 0; index < 25; index++) {
        const input = event({
          type: "latency",
          value: 200,
          timestamp: new Date(base + 1000 + index).toISOString(),
        });
        await f.direct.accept(input);
        await f.direct.processEvent(input.id);
      }
      const closing = event({
        type: "latency",
        value: 1,
        timestamp: new Date(base + 61000).toISOString(),
      });
      await f.direct.accept(closing);
      await f.direct.processEvent(closing.id);
      const stored = (
        await f.direct.pool.query<{ samples: number; event_ids: string[] }>(
          "SELECT samples, event_ids FROM rule_matches",
        )
      ).rows[0]!;
      expect(stored.samples).toBe(25);
      expect(stored.event_ids).toHaveLength(20);
    },
    () => f.dispose(),
  );
});

it("finishes a completed runbook instead of compensating it after the deadline", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      const id = randomUUID();
      const definition = {
        name: "one step",
        timeoutSeconds: 60,
        steps: [{ type: "assign", assignee: "Automation" }],
      };
      await f.direct.pool.query(
        "INSERT INTO runbooks(id,name,definition) VALUES($1,$2,$3)",
        [id, definition.name, definition],
      );
      const run = await f.direct.transaction((client) =>
        startRun(client, id, incident.id, "review"),
      );
      await runbookTick(f.direct);
      expect((await f.direct.incident(incident.id)).assignee).toBe(
        "Automation",
      );
      await f.direct.pool.query(
        "UPDATE runbook_runs SET state='running', deadline_at=now()-interval '1 second' WHERE id=$1",
        [run.id],
      );
      await runbookTick(f.direct);
      expect(
        (
          await f.direct.pool.query(
            "SELECT state FROM runbook_runs WHERE id=$1",
            [run.id],
          )
        ).rows[0].state,
      ).toBe("succeeded");
      expect((await f.direct.incident(incident.id)).assignee).toBe(
        "Automation",
      );
    },
    () => f.dispose(),
  );
});

it("rolls back a runbook when its audit insert fails", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const { app } = await f.startApi();
      const created = await app.inject({
        method: "POST",
        url: "/api/runbooks",
        payload: { name: "review-ok", steps: [{ type: "note", text: "ok" }] },
      });
      expect(created.statusCode).toBe(200);
      expect(
        (
          await f.direct.pool.query(
            "SELECT id FROM audit_entries WHERE payload->>'text' = 'Runbook created: review-ok'",
          )
        ).rowCount,
      ).toBe(1);
      await f.direct.pool.query(
        `CREATE FUNCTION review_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`,
      );
      await f.direct.pool.query(
        "CREATE TRIGGER review_fail_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION review_fail_audit()",
      );
      const response = await app.inject({
        method: "POST",
        url: "/api/runbooks",
        payload: {
          name: "review-atomic",
          steps: [{ type: "note", text: "review" }],
        },
      });
      expect(response.statusCode).toBe(500);
      expect(
        (
          await f.direct.pool.query(
            "SELECT id FROM runbooks WHERE name='review-atomic'",
          )
        ).rowCount,
      ).toBe(0);
    },
    () => f.dispose(),
  );
});

it("allows refresh when context changes but throttles same-context reuse within a minute", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      const ai = new AiService(
        f.direct,
        { enabled: true, model: "test", dailyLimit: 50 },
        async (context) => fixtureAnalysis(context),
      );
      const first = await ai.request(incident.id, incident.version, "review");
      await ai.process(first.id);
      const again = await ai.request(incident.id, incident.version, "review");
      expect(again.id).toBe(first.id);
      const changed = await f.direct.update(incident.id, incident.version, {
        comment: "new evidence",
      });
      const refreshed = await ai.request(
        incident.id,
        changed.version,
        "review",
      );
      expect(refreshed.id).not.toBe(first.id);
      expect(refreshed.state).toBe("queued");
    },
    () => f.dispose(),
  );
});
