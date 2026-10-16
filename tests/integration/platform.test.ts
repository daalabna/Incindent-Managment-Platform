import { randomUUID } from "node:crypto";
import { encodePageCursor } from "../../server/http/page-cursor";
import { expect, it, vi } from "vitest";
import { createIsolated, withCleanup } from "../support/isolated-infra";
import { event } from "./helpers";
import { addDependency } from "../../server/db/event-time";
import { closeIdleStreams } from "../../server/db/idle-watermark";
import {
  startRun,
  cancelRun,
  runbookTick,
} from "../../server/operations/runbooks";
import { notificationTick } from "../../server/operations/notifications";
import { retain } from "../../server/operations/retention";
import { createUser } from "../../server/security/auth";
import { PostgresStore } from "../../server/db/postgres";

it("persists delivery budgets and atomically audits generation-checked replay", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      for (let i = 0; i < 4; i++)
        expect(await f.direct.beginDelivery(input.id, 0)).toBe(true);
      await expect(f.direct.beginDelivery(input.id, 0)).rejects.toThrow(
        /budget/,
      );
      await f.direct.terminalDelivery(input.id, 0, "budget exhausted");
      expect((await f.direct.eventStatus(input.id)).status).toBe("failed");
      const replay = await f.direct.replay(
        input.id,
        0,
        "admin",
        "dependency recovered",
      );
      expect(replay.generation).toBe(1);
      expect(await f.direct.beginDelivery(input.id, 0)).toBe(false);
      await expect(
        f.direct.replay(input.id, 0, "admin", "duplicate replay"),
      ).rejects.toThrow(/conflict/);
      expect(await f.direct.beginDelivery(input.id, 1)).toBe(true);
      expect(
        (await f.direct.snapshot()).audit.some((a) =>
          a.text.includes("dependency recovered"),
        ),
      ).toBe(true);
    },
    () => f.dispose(),
  );
});

it("finalizes event-time windows, rejects late projection changes and correlates a dependency", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      await f.direct.toggleRule("rule-search-errors", false);
      await f.direct.toggleRule("rule-search-latency", false);
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
      ]) {
        const e = event({
          type: "latency",
          value,
          timestamp: new Date(base + delta).toISOString(),
        });
        await f.direct.accept(e);
        await f.direct.processEvent(e.id);
      }
      expect((await f.direct.snapshot()).incidents).toHaveLength(1);
      const late = event({
        type: "latency",
        value: 900,
        timestamp: new Date(base + 5000).toISOString(),
      });
      await f.direct.accept(late);
      await f.direct.processEvent(late.id);
      expect(
        (await f.direct.snapshot()).services.find((s) => s.id === "search-api")
          ?.latency,
      ).toBe(10);
      await f.direct.transaction((c) =>
        addDependency(c, "payments", "search-api"),
      );
      await expect(
        f.direct.transaction((c) => addDependency(c, "search-api", "payments")),
      ).rejects.toThrow(/acyclic/);
      const payment = event({ source: "payments" });
      await f.direct.accept(payment);
      await f.direct.processEvent(payment.id);
      expect((await f.direct.snapshot()).incidents).toHaveLength(1);
      await f.direct.addRule({
        serviceId: "users",
        metric: "error_rate",
        threshold: 1,
        severity: "P2",
        enabled: true,
      });
      await f.direct.addRule({
        serviceId: "notifications",
        metric: "error_rate",
        threshold: 1,
        severity: "P2",
        enabled: true,
      });
      await f.direct.transaction((c) => addDependency(c, "users", "redis"));
      await f.direct.transaction((c) =>
        addDependency(c, "notifications", "redis"),
      );
      const note = event({
        source: "notifications",
        type: "error_rate",
        value: 9,
      });
      await f.direct.accept(note);
      await f.direct.processEvent(note.id);
      const user = event({ source: "users", type: "error_rate", value: 9 });
      await f.direct.accept(user);
      await f.direct.processEvent(user.id);
      const siblings = (await f.direct.snapshot()).incidents
        .map((item) => item.serviceId)
        .filter((id) => id === "users" || id === "notifications")
        .sort();
      expect(siblings).toEqual(["notifications", "users"]);
    },
    () => f.dispose(),
  );
});

it("persists runbook cancellation and compensates assignment without sending notifications", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      const id = randomUUID();
      const definition = {
        name: "recover",
        timeoutSeconds: 60,
        steps: [
          { type: "assign", assignee: "Automation" },
          { type: "wait", seconds: 30 },
        ],
      };
      await f.direct.pool.query(
        "INSERT INTO runbooks(id,name,definition) VALUES($1,$2,$3)",
        [id, "recover", definition],
      );
      const run = await f.direct.transaction((c) =>
        startRun(c, id, incident.id, "admin"),
      );
      await runbookTick(f.direct);
      expect((await f.direct.incident(incident.id)).assignee).toBe(
        "Automation",
      );
      const version = (
        await f.direct.pool.query<{ version: number }>(
          "SELECT version FROM runbook_runs WHERE id=$1",
          [run.id],
        )
      ).rows[0]!.version;
      await f.direct.transaction((c) => cancelRun(c, run.id, version, "admin"));
      await runbookTick(f.direct);
      await runbookTick(f.direct);
      expect((await f.direct.incident(incident.id)).assignee).toBeNull();
      expect(
        (
          await f.direct.pool.query(
            "SELECT state FROM runbook_runs WHERE id=$1",
            [run.id],
          )
        ).rows[0].state,
      ).toBe("cancelled");
      const fetch = vi.spyOn(globalThis, "fetch");
      try {
        await notificationTick(f.direct);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
      expect(
        (await f.direct.pool.query("SELECT state FROM notification_jobs"))
          .rows[0].state,
      ).toBe("sent");
    },
    () => f.dispose(),
  );
});

it("strips payloads for aged terminal-failed events as well as processed ones", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const failed = event({ id: randomUUID(), value: 9.1 });
      await f.direct.accept(failed);
      await f.direct.transaction((client) =>
        client.query(
          `UPDATE monitoring_events SET failure='terminal', terminal_at=now()-interval '10 days', processed_at=NULL WHERE id=$1`,
          [failed.id],
        ),
      );
      const plan = await f.direct.transaction((c) =>
        retain(c, 7, true, "admin"),
      );
      expect(plan.events).toBeGreaterThanOrEqual(1);
      await f.direct.transaction((c) => retain(c, 7, false, "admin"));
      const row = (
        await f.direct.pool.query<{
          payload: unknown;
          fingerprint: unknown;
        }>("SELECT payload, fingerprint FROM monitoring_events WHERE id=$1", [
          failed.id,
        ])
      ).rows[0]!;
      expect(row.payload).toBeNull();
      expect(row.fingerprint).toMatchObject({
        source: failed.source,
        type: failed.type,
        value: failed.value,
      });
    },
    () => f.dispose(),
  );
});

it("compacts retained payloads but preserves idempotency and rejects ID conflicts", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const e = event();
      await f.direct.accept(e);
      await f.direct.processEvent(e.id);
      await f.direct.pool.query(
        "UPDATE monitoring_events SET processed_at=now()-interval '10 days' WHERE id=$1",
        [e.id],
      );
      expect(
        (await f.direct.transaction((c) => retain(c, 7, true, "admin"))).events,
      ).toBe(1);
      await f.direct.transaction((c) => retain(c, 7, false, "admin"));
      expect((await f.direct.accept(e)).duplicate).toBe(true);
      await expect(f.direct.accept({ ...e, value: 50 })).rejects.toThrow(
        /different event/,
      );
      expect((await f.direct.summary()).eventCount).toBe(1);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      await f.direct.pool.query(
        `INSERT INTO ai_analyses(id,incident_id,incident_version,context_hash,context,model,prompt_version,state,requested_by,completed_at)
      VALUES($1,$2,1,'hash',$3,'model','v1','succeeded','admin',now()-interval '10 days')`,
        [
          randomUUID(),
          incident.id,
          {
            incidentId: incident.id,
            incidentVersion: 1,
            sources: [
              {
                id: "event:1",
                kind: "event",
                label: "e",
                text: "secret-context",
              },
            ],
            limitations: [],
          },
        ],
      );
      await f.direct.pool.query(
        `INSERT INTO dead_letters(event_id,generation,reason,created_at,replayed_at) VALUES($1,9,'old',now()-interval '10 days',now()-interval '10 days')`,
        [e.id],
      );
      await f.direct.pool.query(
        `INSERT INTO dead_letters(event_id,generation,reason,created_at) VALUES($1,8,'open',now()-interval '10 days')`,
        [e.id],
      );
      await f.direct.transaction((c) => retain(c, 7, false, "admin"));
      const kept = (
        await f.direct.pool.query<{
          context: { sources: unknown[]; limitations: string[] };
        }>("SELECT context FROM ai_analyses")
      ).rows[0]!.context;
      expect(kept.sources).toEqual([]);
      expect(kept.limitations).toContain("Контекст удалён политикой хранения.");
      expect(
        (
          await f.direct.pool.query<{ generation: number }>(
            "SELECT generation FROM dead_letters ORDER BY generation",
          )
        ).rows.map((row) => row.generation),
      ).toEqual([8]);
      expect((await f.direct.incident(incident.id)).status).toBe("triggered");
    },
    () => f.dispose(),
  );
});

it("isolates tenant schemas and enforces authenticated viewer writes and CSRF", async () => {
  const f = await createIsolated();
  const other = new PostgresStore(f.config.databaseUrl, "tenant_other");
  await withCleanup(
    async () => {
      await other.migrate();
      await createUser(f.direct, "viewer", "test-password-long", "viewer");
      await createUser(f.direct, "admin", "test-password-long", "admin");
      const e = event();
      await f.direct.accept(e);
      await f.direct.processEvent(e.id);
      expect((await other.snapshot()).incidents).toHaveLength(0);
      vi.stubEnv("AUTH_REQUIRED", "true");
      vi.stubEnv("COOKIE_SECURE", "false");
      const { app } = await f.startApi();
      expect((await app.inject("/api/summary")).statusCode).toBe(401);
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "viewer", password: "test-password-long" },
      });
      expect(login.statusCode).toBe(200);
      const headers = {
        cookie: String(login.headers["set-cookie"]).split(";")[0]!,
        "x-csrf-token": login.json().csrf,
      };
      expect(
        (await app.inject({ url: "/api/summary", headers })).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            url: "/api/events",
            method: "POST",
            headers,
            payload: event(),
          })
        ).statusCode,
      ).toBe(403);
      const admin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "test-password-long" },
      });
      const adminCookie = String(admin.headers["set-cookie"]).split(";")[0]!;
      expect(
        (
          await app.inject({
            url: "/api/events",
            method: "POST",
            headers: { cookie: adminCookie },
            payload: event(),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: "/api/events",
            method: "POST",
            headers: { cookie: adminCookie, "x-csrf-token": admin.json().csrf },
            payload: event(),
          })
        ).statusCode,
      ).toBe(202);
    },
    async () => {
      vi.unstubAllEnvs();
      await other.close();
      await f.dispose();
    },
  );
});

it("keeps the second operations row when timestamps differ only by microseconds", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const { app } = await f.startApi();
      await f.direct.pool.query("DELETE FROM runbooks");
      const ids = [randomUUID(), randomUUID()].sort();
      for (const id of ids)
        await f.direct.pool.query(
          "INSERT INTO runbooks(id,name,definition,created_at) VALUES($1,'review',$2,'2026-10-01T00:00:00.123456Z')",
          [id, { name: "review", steps: [{ type: "note", text: "review" }] }],
        );
      const page = (await app.inject("/api/runbooks?limit=1")).json();
      expect(page.items).toHaveLength(1);
      const next = (
        await app.inject(
          `/api/runbooks?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
        )
      ).json();
      expect(next.items).toHaveLength(1);
      expect(next.items[0].id).not.toBe(page.items[0].id);
      expect(
        (await app.inject("/api/runbooks?cursor=not-a-cursor")).statusCode,
      ).toBe(400);
    },
    () => f.dispose(),
  );
});

it("closes an idle event-time window without inventing a newer sample", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      await f.direct.toggleRule("rule-search-errors", false);
      await f.direct.toggleRule("rule-search-latency", false);
      await f.direct.addRule({
        serviceId: "search-api",
        metric: "latency",
        threshold: 100,
        severity: "P2",
        enabled: true,
        windowSeconds: 60,
        allowedLatenessSeconds: 0,
        minSamples: 1,
        aggregation: "max",
      });
      const first = event({
        type: "latency",
        value: 200,
        timestamp: new Date(Date.now() - 120_000).toISOString(),
      });
      await f.direct.accept(first);
      await f.direct.processEvent(first.id);
      expect((await f.direct.snapshot()).incidents).toHaveLength(0);
      await f.direct.transaction((client) => closeIdleStreams(client));
      expect((await f.direct.snapshot()).incidents).toHaveLength(1);
      expect(
        (
          await f.direct.pool.query<{ samples: number }>(
            "SELECT count(*)::int AS samples FROM metric_samples",
          )
        ).rows[0]?.samples,
      ).toBe(1);
      const mark = (
        await f.direct.pool.query<{ watermark: Date }>(
          "SELECT watermark FROM stream_watermarks WHERE service_id=$1 AND metric=$2",
          ["search-api", "latency"],
        )
      ).rows[0]!;
      expect(Date.now() - mark.watermark.getTime()).toBeLessThan(5_000);
      const late = event({
        type: "latency",
        value: 900,
        timestamp: new Date(Date.now() - 30_000).toISOString(),
      });
      await f.direct.accept(late);
      await f.direct.processEvent(late.id);
      expect(
        (await f.direct.snapshot()).services.find(
          (service) => service.id === "search-api",
        )?.latency,
      ).toBe(200);
    },
    () => f.dispose(),
  );
});

it("rate-limits invalid bearer tokens before they keep reading sessions", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      vi.stubEnv("AUTH_REQUIRED", "true");
      const { app, api } = await f.startApi();
      const originalGet = api.redis.client.get.bind(api.redis.client);
      const get = vi
        .spyOn(api.redis.client, "get")
        .mockImplementation(async (key) =>
          String(key).includes(":rate:authn:") &&
          !String(key).includes("fallback")
            ? "60"
            : originalGet(key),
        );
      const originalQuery = api.store.pool.query.bind(api.store.pool);
      let sessionReads = 0;
      const query = vi
        .spyOn(api.store.pool, "query")
        .mockImplementation(async (sql: string, params?: unknown[]) => {
          if (
            typeof sql === "string" &&
            sql.includes("FROM auth_sessions s JOIN auth_users")
          )
            sessionReads += 1;
          return originalQuery(sql, params);
        });
      try {
        const codes = [];
        for (let i = 0; i < 8; i++)
          codes.push(
            (
              await app.inject({
                url: "/api/incidents",
                headers: { authorization: `Bearer invalid-review-${i}` },
              })
            ).statusCode,
          );
        expect(codes.every((code) => code === 429)).toBe(true);
        expect(sessionReads).toBe(5);
      } finally {
        query.mockRestore();
        get.mockRestore();
      }
    },
    async () => {
      vi.unstubAllEnvs();
      await f.dispose();
    },
  );
});

it("lets a valid session pass the invalid-token ceiling", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      vi.stubEnv("AUTH_REQUIRED", "true");
      vi.stubEnv("COOKIE_SECURE", "false");
      await createUser(f.direct, "operator", "test-password-long", "operator");
      const { app } = await f.startApi();
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "operator", password: "test-password-long" },
      });
      const headers = {
        cookie: String(login.headers["set-cookie"]).split(";")[0]!,
      };
      const codes = [];
      for (let i = 0; i < 65; i++)
        codes.push(
          (await app.inject({ url: "/api/summary", headers })).statusCode,
        );
      expect(codes.every((code) => code === 200)).toBe(true);
      const rejected = [];
      for (let i = 0; i < 65; i++)
        rejected.push(
          (
            await app.inject({
              url: "/api/incidents",
              headers: { authorization: "Bearer invalid-review-token" },
            })
          ).statusCode,
        );
      expect(rejected.at(-1)).toBe(429);
      expect(
        (await app.inject({ url: "/api/summary", headers })).statusCode,
      ).toBe(200);
      await f.direct.pool.query(
        `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=(SELECT id FROM auth_users WHERE username='operator')`,
      );
      expect(
        (await app.inject({ url: "/api/summary", headers })).statusCode,
      ).toBe(401);
      const again = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "operator", password: "test-password-long" },
      });
      const next = {
        cookie: String(again.headers["set-cookie"]).split(";")[0]!,
      };
      expect(
        (await app.inject({ url: "/api/summary", headers: next })).statusCode,
      ).toBe(200);
      await f.direct.pool.query(
        `UPDATE auth_users SET disabled=true WHERE username='operator'`,
      );
      expect(
        (await app.inject({ url: "/api/summary", headers: next })).statusCode,
      ).toBe(401);
    },
    async () => {
      vi.unstubAllEnvs();
      await f.dispose();
    },
  );
});

it("round-trips an operations cursor that contains a pipe and microseconds", () => {
  const cursor = encodePageCursor({
    at: "2026-10-01T00:00:00.123456Z",
    id: "event|part",
    generation: 2,
  });
  expect(cursor.includes("|")).toBe(false);
});
