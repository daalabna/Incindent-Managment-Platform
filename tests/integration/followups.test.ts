import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { collectContext } from "../../server/ai/context";
import { runbookTick, startRun } from "../../server/operations/runbooks";
import { createUser } from "../../server/security/auth";
import { createIsolated, withCleanup } from "../support/isolated-infra";
import { event } from "./helpers";

it("keeps a final wait running until its delay elapses", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      const id = randomUUID();
      const definition = {
        name: "wait only",
        timeoutSeconds: 3600,
        steps: [{ type: "wait", seconds: 300 }],
      };
      await f.direct.pool.query(
        "INSERT INTO runbooks(id,name,definition) VALUES($1,$2,$3)",
        [id, definition.name, definition],
      );
      const run = await f.direct.transaction((client) =>
        startRun(client, id, incident.id, "review"),
      );
      await runbookTick(f.direct);
      const waiting = (
        await f.direct.pool.query<{ state: string; future: boolean }>(
          "SELECT state, available_at>now() AS future FROM runbook_runs WHERE id=$1",
          [run.id],
        )
      ).rows[0]!;
      expect(waiting).toMatchObject({ state: "running", future: true });
      await f.direct.pool.query(
        "UPDATE runbook_runs SET available_at=now()-interval '2 minutes', deadline_at=now()-interval '1 minute' WHERE id=$1",
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
    },
    () => f.dispose(),
  );
});

it("times out a final wait when the deadline passed before the wait ended", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      const id = randomUUID();
      const definition = {
        name: "wait deadline",
        timeoutSeconds: 3600,
        steps: [{ type: "wait", seconds: 300 }],
      };
      await f.direct.pool.query(
        "INSERT INTO runbooks(id,name,definition) VALUES($1,$2,$3)",
        [id, definition.name, definition],
      );
      const run = await f.direct.transaction((client) =>
        startRun(client, id, incident.id, "review"),
      );
      await runbookTick(f.direct);
      await f.direct.pool.query(
        "UPDATE runbook_runs SET available_at=now()-interval '1 second', deadline_at=now()-interval '1 minute' WHERE id=$1",
        [run.id],
      );
      await runbookTick(f.direct);
      expect(
        (
          await f.direct.pool.query(
            "SELECT state, context->>'outcome' AS outcome FROM runbook_runs WHERE id=$1",
            [run.id],
          )
        ).rows[0],
      ).toMatchObject({ state: "timed_out", outcome: "timed_out" });
    },
    () => f.dispose(),
  );
});

it("rolls back a dependency when its audit insert fails", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const { app } = await f.startApi();
      const services = (await f.direct.snapshot()).services;
      const source = services[0]!.id;
      const target = services[1]!.id;
      await f.direct.pool.query("DELETE FROM service_dependencies");
      const created = await app.inject({
        method: "POST",
        url: "/api/dependencies",
        payload: { serviceId: source, dependsOn: target },
      });
      expect(created.statusCode).toBe(200);
      expect(
        (
          await f.direct.pool.query(
            "SELECT id FROM audit_entries WHERE payload->>'text' LIKE 'Dependency %'",
          )
        ).rowCount,
      ).toBe(1);
      await f.direct.pool.query(
        `CREATE FUNCTION review_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`,
      );
      await f.direct.pool.query(
        "CREATE TRIGGER review_fail_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION review_fail_audit()",
      );
      const other = services[2]!.id;
      const response = await app.inject({
        method: "POST",
        url: "/api/dependencies",
        payload: { serviceId: source, dependsOn: other },
      });
      expect(response.statusCode).toBe(500);
      expect(
        (
          await f.direct.pool.query(
            "SELECT * FROM service_dependencies WHERE service_id=$1 AND depends_on=$2",
            [source, other],
          )
        ).rowCount,
      ).toBe(0);
    },
    () => f.dispose(),
  );
});

it("removes the login session when the session cache write fails", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      vi.stubEnv("AUTH_REQUIRED", "true");
      vi.stubEnv("COOKIE_SECURE", "false");
      try {
        await createUser(
          f.direct,
          "operator",
          "test-password-long",
          "operator",
        );
        const { app, api } = await f.startApi();
        const set = vi
          .spyOn(api.redis.client, "set")
          .mockRejectedValueOnce(new Error("redis down"));
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "operator", password: "test-password-long" },
        });
        expect(response.statusCode).toBe(503);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(
          (await f.direct.pool.query("SELECT token_hash FROM auth_sessions"))
            .rowCount,
        ).toBe(0);
        expect(
          (
            await f.direct.pool.query(
              "SELECT id FROM audit_entries WHERE payload->>'text' = 'Login: operator'",
            )
          ).rowCount,
        ).toBe(0);
        set.mockRestore();
      } finally {
        vi.unstubAllEnvs();
      }
    },
    () => f.dispose(),
  );
});

it("rolls back a login session when its audit insert fails", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      vi.stubEnv("AUTH_REQUIRED", "true");
      vi.stubEnv("COOKIE_SECURE", "false");
      try {
        await createUser(
          f.direct,
          "operator",
          "test-password-long",
          "operator",
        );
        const { app } = await f.startApi();
        const ok = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "operator", password: "test-password-long" },
        });
        expect(ok.statusCode).toBe(200);
        expect(
          (
            await f.direct.pool.query(
              "SELECT id FROM audit_entries WHERE payload->>'text' = 'Login: operator'",
            )
          ).rowCount,
        ).toBe(1);
        await f.direct.pool.query("DELETE FROM auth_sessions");
        await f.direct.pool.query(
          `CREATE FUNCTION review_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`,
        );
        await f.direct.pool.query(
          "CREATE TRIGGER review_fail_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION review_fail_audit()",
        );
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "operator", password: "test-password-long" },
        });
        expect(response.statusCode).toBe(500);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(
          (await f.direct.pool.query("SELECT token_hash FROM auth_sessions"))
            .rowCount,
        ).toBe(0);
      } finally {
        vi.unstubAllEnvs();
      }
    },
    () => f.dispose(),
  );
});

it("rolls back a user when its audit insert fails", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      vi.stubEnv("AUTH_REQUIRED", "true");
      vi.stubEnv("COOKIE_SECURE", "false");
      try {
        await createUser(f.direct, "admin", "test-password-long", "admin");
        const { app } = await f.startApi();
        const login = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "admin", password: "test-password-long" },
        });
        const headers = {
          cookie: String(login.headers["set-cookie"]).split(";")[0]!,
          "x-csrf-token": login.json().csrf as string,
        };
        const ok = await app.inject({
          method: "POST",
          url: "/api/users",
          headers,
          payload: {
            username: "review-ok",
            password: "test-password-long",
            role: "operator",
          },
        });
        expect(ok.statusCode).toBe(200);
        expect(
          (
            await f.direct.pool.query(
              "SELECT id FROM audit_entries WHERE payload->>'text' = 'User created: review-ok (operator)'",
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
          url: "/api/users",
          headers,
          payload: {
            username: "review-orphan",
            password: "test-password-long",
            role: "operator",
          },
        });
        expect(response.statusCode).toBe(500);
        expect(
          (
            await f.direct.pool.query(
              "SELECT id FROM auth_users WHERE username='review-orphan'",
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        vi.unstubAllEnvs();
      }
    },
    () => f.dispose(),
  );
});

it("names the service and rule on window evidence from another service", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const state = await f.direct.snapshot();
      const incident = state.incidents[0]!;
      const service = state.services.find(
        (item) => item.id !== incident.serviceId,
      )!;
      const rule = await f.direct.addRule({
        serviceId: service.id,
        metric: "latency",
        threshold: 100,
        severity: "P2",
        enabled: true,
        windowSeconds: 60,
        allowedLatenessSeconds: 0,
        minSamples: 2,
        aggregation: "avg",
      });
      await f.direct.pool.query(
        `INSERT INTO rule_matches(id,incident_id,rule_id,service_id,metric,aggregation,threshold,value,samples,window_start,window_end,event_ids)
      VALUES($1,$2,$3,$4,'latency','avg',100,200,2,now()-interval '1 minute',now(),'{}')`,
        [randomUUID(), incident.id, rule.id, service.id],
      );
      const context = await f.direct.transaction((client) =>
        collectContext(client, incident.id),
      );
      const source = context.sources.find(
        (item) => item.label === "срабатывание окна latency",
      );
      expect(source?.text).toContain(service.id);
      expect(source?.text).toContain(rule.id);
      expect(JSON.parse(source!.text)).toMatchObject({
        serviceId: service.id,
        ruleId: rule.id,
      });
    },
    () => f.dispose(),
  );
});

it("rejects a second active runbook on the same incident", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      const a = randomUUID();
      const b = randomUUID();
      const def = {
        name: "w",
        timeoutSeconds: 3600,
        steps: [{ type: "wait" as const, seconds: 300 }],
      };
      await f.direct.pool.query(
        "INSERT INTO runbooks(id,name,definition) VALUES($1,$2,$3),($4,$5,$6)",
        [a, "a", def, b, "b", def],
      );
      await f.direct.transaction((client) =>
        startRun(client, a, incident.id, "review"),
      );
      await expect(
        f.direct.transaction((client) =>
          startRun(client, b, incident.id, "review"),
        ),
      ).rejects.toThrow(/already active/);
    },
    () => f.dispose(),
  );
});

it("rejects authn when redis rate-limit eval fails closed", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      vi.stubEnv("AUTH_REQUIRED", "true");
      vi.stubEnv("COOKIE_SECURE", "false");
      try {
        await createUser(f.direct, "op", "test-password-long", "operator");
        const { app, api } = await f.startApi();
        const evalSpy = vi
          .spyOn(api.redis.client, "eval")
          .mockRejectedValue(new Error("redis down"));
        const response = await app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { authorization: "Bearer invalid-token" },
        });
        expect(response.statusCode).toBe(503);
        evalSpy.mockRestore();
      } finally {
        vi.unstubAllEnvs();
      }
    },
    () => f.dispose(),
  );
});

it("rejects login when redis rate-limit eval fails closed", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      vi.stubEnv("AUTH_REQUIRED", "true");
      vi.stubEnv("COOKIE_SECURE", "false");
      try {
        await createUser(f.direct, "op", "test-password-long", "operator");
        const { app, api } = await f.startApi();
        const evalSpy = vi
          .spyOn(api.redis.client, "eval")
          .mockRejectedValue(new Error("redis down"));
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "op", password: "wrong-password-long" },
        });
        expect(response.statusCode).toBe(503);
        evalSpy.mockRestore();
      } finally {
        vi.unstubAllEnvs();
      }
    },
    () => f.dispose(),
  );
});

it("does not reopen notification when force-sent fails after delivery", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const { notificationTick } =
        await import("../../server/operations/notifications");
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      await f.direct.pool.query(
        "DELETE FROM notification_jobs WHERE incident_id=$1",
        [incident.id],
      );
      const id = randomUUID();
      await f.direct.pool.query(
        `INSERT INTO notification_jobs(id,incident_id,adapter,payload,state,attempts)
       VALUES($1,$2,$3,$4,'pending',0)`,
        [
          id,
          incident.id,
          "journal",
          { incidentId: incident.id, text: "review" },
        ],
      );
      const origTx = f.direct.transaction.bind(f.direct);
      let txCalls = 0;
      const txSpy = vi
        .spyOn(f.direct, "transaction")
        .mockImplementation(async (fn) => {
          txCalls += 1;
          if (txCalls === 2) throw new Error("settle boom");
          return origTx(fn);
        });
      const origQuery = f.direct.pool.query.bind(f.direct.pool);
      const querySpy = vi
        .spyOn(f.direct.pool, "query")
        .mockImplementation(async (text: string, params?: unknown[]) => {
          if (
            typeof text === "string" &&
            text.includes("state='sent'") &&
            text.includes("state<>")
          )
            throw new Error("force-sent boom");
          return origQuery(text, params);
        });
      await notificationTick(f.direct);
      txSpy.mockRestore();
      querySpy.mockRestore();
      const state = (
        await f.direct.pool.query(
          "SELECT state FROM notification_jobs WHERE id=$1",
          [id],
        )
      ).rows[0].state;
      expect(state).not.toBe("pending");
      expect(state).not.toBe("failed");
    },
    () => f.dispose(),
  );
});

it("defers notification audit without resend when settle fails after delivery", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const { notificationTick } =
        await import("../../server/operations/notifications");
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      await f.direct.pool.query(
        "DELETE FROM notification_jobs WHERE incident_id=$1",
        [incident.id],
      );
      const id = randomUUID();
      await f.direct.pool.query(
        `INSERT INTO notification_jobs(id,incident_id,adapter,payload,state,attempts)
       VALUES($1,$2,$3,$4,'pending',0)`,
        [
          id,
          incident.id,
          "journal",
          { incidentId: incident.id, text: "review" },
        ],
      );
      const orig = f.direct.transaction.bind(f.direct);
      let calls = 0;
      const spy = vi
        .spyOn(f.direct, "transaction")
        .mockImplementation(async (fn) => {
          calls += 1;
          if (calls === 2) throw new Error("settle boom");
          return orig(fn);
        });
      await notificationTick(f.direct);
      spy.mockRestore();
      expect(
        (
          await f.direct.pool.query(
            "SELECT state,error FROM notification_jobs WHERE id=$1",
            [id],
          )
        ).rows[0],
      ).toMatchObject({ state: "audit_pending", error: "settle boom" });
      await notificationTick(f.direct);
      expect(
        (
          await f.direct.pool.query(
            "SELECT state FROM notification_jobs WHERE id=$1",
            [id],
          )
        ).rows[0].state,
      ).toBe("sent");
      expect(
        (
          await f.direct.pool.query(
            "SELECT count(*)::int AS count FROM audit_entries WHERE payload->>'text' LIKE $1",
            [`Notification ${id}%`],
          )
        ).rows[0].count,
      ).toBe(1);
    },
    () => f.dispose(),
  );
});

it("keeps notification sent when webhook body.cancel fails after HTTP 200", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const { notificationTick } =
        await import("../../server/operations/notifications");
      process.env.NOTIFICATION_DELIVERY = "enabled";
      process.env.NOTIFICATION_WEBHOOK_URL = "https://hooks.example/sentinel";
      process.env.NOTIFICATION_WEBHOOK_SECRET = "secret";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          body: {
            cancel: async () => {
              throw new Error("cancel boom");
            },
          },
        })),
      );
      try {
        const input = event();
        await f.direct.accept(input);
        await f.direct.processEvent(input.id);
        const incident = (await f.direct.snapshot()).incidents[0]!;
        await f.direct.pool.query(
          "DELETE FROM notification_jobs WHERE incident_id=$1",
          [incident.id],
        );
        const id = randomUUID();
        await f.direct.pool.query(
          `INSERT INTO notification_jobs(id,incident_id,adapter,payload,state,attempts)
         VALUES($1,$2,$3,$4,'pending',0)`,
          [
            id,
            incident.id,
            "webhook",
            { incidentId: incident.id, text: "review" },
          ],
        );
        await notificationTick(f.direct);
        expect(
          (
            await f.direct.pool.query(
              "SELECT state FROM notification_jobs WHERE id=$1",
              [id],
            )
          ).rows[0].state,
        ).toBe("sent");
      } finally {
        vi.unstubAllGlobals();
        delete process.env.NOTIFICATION_DELIVERY;
        delete process.env.NOTIFICATION_WEBHOOK_URL;
        delete process.env.NOTIFICATION_WEBHOOK_SECRET;
      }
    },
    () => f.dispose(),
  );
});

it("exposes notification delivery errors through the API", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      const failedId = randomUUID();
      await f.direct.pool.query(
        `INSERT INTO notification_jobs(id,incident_id,adapter,payload,state,attempts,error)
       VALUES($1,$2,$3,$4,'failed',5,'delivery boom')`,
        [failedId, incident.id, `review:${failedId}`, { text: "x" }],
      );
      const { app } = await f.startApi();
      const response = await app.inject({
        method: "GET",
        url: "/api/notifications",
      });
      const item = response
        .json()
        .items.find((row: { id: string }) => row.id === failedId);
      expect(item).toMatchObject({ id: failedId, error: "delivery boom" });
    },
    () => f.dispose(),
  );
});

it("keeps auth working when redis allowlist write fails and clears cookie if redis.del fails on logout", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      vi.stubEnv("AUTH_REQUIRED", "true");
      vi.stubEnv("COOKIE_SECURE", "false");
      try {
        await createUser(f.direct, "op", "test-password-long", "operator");
        const { app, api } = await f.startApi();
        const login = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "op", password: "test-password-long" },
        });
        const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
        const csrf = login.json().csrf as string;
        const set = vi
          .spyOn(api.redis.client, "set")
          .mockRejectedValueOnce(new Error("redis down"));
        expect(
          (
            await app.inject({
              method: "GET",
              url: "/api/auth/me",
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(200);
        set.mockRestore();
        const evalSpy = vi
          .spyOn(api.redis.client, "eval")
          .mockRejectedValueOnce(new Error("redis down"));
        // Session auth stays available (user rate-limit fail-open); health fails closed.
        expect(
          (
            await app.inject({
              method: "GET",
              url: "/api/auth/me",
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (await app.inject({ method: "GET", url: "/api/health" })).statusCode,
        ).toBe(503);
        evalSpy.mockRestore();
        const del = vi
          .spyOn(api.redis.client, "del")
          .mockRejectedValueOnce(new Error("redis down"));
        const logout = await app.inject({
          method: "POST",
          url: "/api/auth/logout",
          headers: { cookie, "x-csrf-token": csrf },
        });
        expect(logout.statusCode).toBe(200);
        expect(String(logout.headers["set-cookie"])).toMatch(/Max-Age=0/);
        del.mockRestore();
      } finally {
        vi.unstubAllEnvs();
      }
    },
    () => f.dispose(),
  );
});
