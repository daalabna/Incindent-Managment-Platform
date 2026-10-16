import { expect, it, vi } from "vitest";
import { createIsolated, withCleanup } from "../support/isolated-infra";
import { fixtureAnalysis } from "../support/ai-fixture";
import { event } from "./helpers";
import { AiService } from "../../server/ai/service";
import { AiFailure } from "../../server/ai/provider";
import { PostgresStore } from "../../server/db/postgres";
import { createUser } from "../../server/security/auth";

it("runs an idempotent analysis through RabbitMQ and marks changed evidence stale", async () => {
  const f = await createIsolated();
  f.config.ai.enabled = true;
  await withCleanup(
    async () => {
      const e = event();
      await f.direct.accept(e);
      await f.direct.processEvent(e.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      const provider = vi.fn(async (context) => fixtureAnalysis(context));
      const { app } = await f.startApi();
      const worker = await f.startWorker(undefined, provider);
      const path = `/api/incidents/${incident.id}/analysis`;
      const responses = await Promise.all([
        app.inject({
          method: "POST",
          url: path,
          payload: { version: incident.version },
        }),
        app.inject({
          method: "POST",
          url: path,
          payload: { version: incident.version },
        }),
      ]);
      expect(responses.map((r) => r.statusCode)).toEqual([202, 202]);
      expect(responses[0]!.json().id).toBe(responses[1]!.json().id);
      await vi.waitFor(
        async () =>
          expect((await worker.ai.status(incident.id)).job?.state).toBe(
            "succeeded",
          ),
        { timeout: 10000 },
      );
      expect(provider).toHaveBeenCalledTimes(1);
      const saved = await app.inject(path);
      expect(
        saved
          .json()
          .job.sources.some((s: { kind: string }) => s.kind === "event"),
      ).toBe(true);
      expect(saved.json().job.stale).toBe(false);
      expect(
        (
          await app.inject({
            method: "POST",
            url: path,
            payload: { version: incident.version },
          })
        ).statusCode,
      ).toBe(200);
      await f.direct.update(incident.id, incident.version, {
        comment: "Additional evidence",
      });
      expect((await app.inject(path)).json().job.stale).toBe(true);
      const unrelated = event({ source: "payments" });
      await f.direct.accept(unrelated);
      await f.direct.processEvent(unrelated.id);
      expect((await f.direct.eventStatus(unrelated.id)).status).toBe(
        "processed",
      );
    },
    () => f.dispose(),
  );
});

it("bounds retries, recovers an abandoned lease and rejects stale worker completion", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const e = event();
      await f.direct.accept(e);
      await f.direct.processEvent(e.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const old = new AiService(
        f.direct,
        { enabled: true, model: "test", dailyLimit: 2 },
        async (c) => {
          await blocked;
          return fixtureAnalysis(c);
        },
      );
      const job = await old.request(incident.id, incident.version, "operator");
      const work = old.process(job.id);
      await vi.waitFor(async () =>
        expect((await old.status(incident.id)).job?.state).toBe("running"),
      );
      await f.direct.pool.query(
        "UPDATE ai_analyses SET lease_until=now()-interval '1 second' WHERE id=$1",
        [job.id],
      );
      await old.publishPending(async () => undefined);
      const fresh = new AiService(
        f.direct,
        { enabled: true, model: "test", dailyLimit: 2 },
        async () => {
          throw new AiFailure("Provider unavailable", true);
        },
      );
      await fresh.process(job.id);
      release();
      await work;
      expect((await old.status(incident.id)).job).toMatchObject({
        state: "failed",
        attempts: 2,
        result: null,
      });
      await expect(
        old.request(incident.id, incident.version, "operator"),
      ).rejects.toThrow(/минут/);
      await f.direct.pool.query(
        "UPDATE ai_analyses SET created_at=now()-interval '2 minutes' WHERE id=$1",
        [job.id],
      );
      const next = await old.request(incident.id, incident.version, "operator");
      expect(next.id).not.toBe(job.id);
      await f.direct.pool.query(
        "UPDATE ai_analyses SET deadline_at=now()-interval '1 second' WHERE id=$1",
        [next.id],
      );
      await old.publishPending(async () => undefined);
      expect((await old.status(incident.id)).job?.state).toBe("failed");
    },
    () => f.dispose(),
  );
});

it("keeps tenant evidence separate and enforces the analysis budget", async () => {
  const f = await createIsolated();
  const other = new PostgresStore(f.config.databaseUrl, "tenant_ai_other");
  await withCleanup(
    async () => {
      await other.migrate();
      for (const store of [f.direct, other]) {
        const e = event();
        await store.accept(e);
        await store.processEvent(e.id);
      }
      const incident = (await f.direct.snapshot()).incidents[0]!;
      await f.direct.update(incident.id, incident.version, {
        comment: "PRIVATE_TENANT_ALPHA",
      });
      const config = { enabled: true, model: "test", dailyLimit: 1 };
      const alpha = new AiService(f.direct, config, async (c) =>
        fixtureAnalysis(c),
      );
      const beta = new AiService(other, config, async (c) =>
        fixtureAnalysis(c),
      );
      const job = await alpha.request(
        incident.id,
        incident.version + 1,
        "operator",
      );
      expect((await beta.status(incident.id)).job).toBeNull();
      const betaJob = await beta.request(
        incident.id,
        incident.version,
        "operator",
      );
      expect(JSON.stringify(betaJob.sources)).not.toContain(
        "PRIVATE_TENANT_ALPHA",
      );
      await alpha.process(job.id);
      await f.direct.pool.query(
        "UPDATE ai_analyses SET created_at=now()-interval '2 minutes' WHERE id=$1",
        [job.id],
      );
      await f.direct.update(incident.id, incident.version + 1, {
        comment: "Changed",
      });
      await expect(
        alpha.request(incident.id, incident.version + 2, "operator"),
      ).rejects.toThrow(/лимит/);
    },
    async () => {
      await other.close();
      await f.dispose();
    },
  );
});

it("requires authentication, operator role and CSRF for AI requests, including query strings", async () => {
  const f = await createIsolated();
  f.config.ai.enabled = true;
  await withCleanup(
    async () => {
      vi.stubEnv("AUTH_REQUIRED", "true");
      vi.stubEnv("COOKIE_SECURE", "false");
      const e = event();
      await f.direct.accept(e);
      await f.direct.processEvent(e.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      await createUser(f.direct, "viewer", "long-test-password", "viewer");
      await createUser(f.direct, "operator", "long-test-password", "operator");
      const { app } = await f.startApi();
      const url = `/api/incidents/${incident.id}/analysis?probe=1`;
      expect((await app.inject(url)).statusCode).toBe(401);
      for (const username of ["viewer", "operator"]) {
        const login = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username, password: "long-test-password" },
        });
        const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
        expect(
          (
            await app.inject({
              method: "POST",
              url,
              headers: { cookie },
              payload: { version: incident.version },
            })
          ).statusCode,
        ).toBe(403);
        const headers = { cookie, "x-csrf-token": login.json().csrf };
        expect(
          (
            await app.inject({
              method: "POST",
              url,
              headers,
              payload: { version: incident.version },
            })
          ).statusCode,
        ).toBe(username === "viewer" ? 403 : 202);
        expect((await app.inject({ url, headers })).statusCode).toBe(200);
        if (username === "operator")
          expect(
            (
              await app.inject({
                method: "POST",
                url: "/api/runbooks?x=1",
                headers,
                payload: {
                  name: "bad",
                  steps: [{ type: "note", text: "bad" }],
                },
              })
            ).statusCode,
          ).toBe(403);
      }
    },
    async () => {
      vi.unstubAllEnvs();
      await f.dispose();
    },
  );
});

it("returns the cached analysis from both POST and GET and commits expiry before a broker failure", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const e = event();
      await f.direct.accept(e);
      await f.direct.processEvent(e.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      const ai = new AiService(
        f.direct,
        { enabled: true, model: "test", dailyLimit: 50 },
        async (context) => fixtureAnalysis(context),
      );
      const first = await ai.request(incident.id, incident.version, "review");
      await ai.process(first.id);
      await f.direct.pool.query(
        "UPDATE ai_analyses SET created_at=now()-interval '4 minutes' WHERE id=$1",
        [first.id],
      );
      const rule = (await f.direct.snapshot()).rules.find(
        (item) => item.serviceId === incident.serviceId,
      )!;
      await f.direct.toggleRule(rule.id, !rule.enabled);
      const second = await ai.request(incident.id, incident.version, "review");
      await ai.process(second.id);
      await f.direct.toggleRule(rule.id, rule.enabled);
      const cached = await ai.request(incident.id, incident.version, "review");
      expect(cached.id).toBe(first.id);
      expect((await ai.status(incident.id)).job?.id).toBe(first.id);
      expect((await ai.status(incident.id)).job?.stale).toBe(false);
      await f.direct.pool.query(
        "UPDATE ai_analyses SET state='queued',deadline_at=now()-interval '1 second' WHERE id=$1",
        [first.id],
      );
      await f.direct.pool.query(
        "UPDATE ai_analyses SET state='queued',published_at=NULL WHERE id=$1",
        [second.id],
      );
      await expect(
        ai.publishPending(async () => {
          throw new Error("synthetic broker outage");
        }),
      ).rejects.toThrow("synthetic");
      expect(
        (
          await f.direct.pool.query(
            "SELECT state FROM ai_analyses WHERE id=$1",
            [first.id],
          )
        ).rows[0].state,
      ).toBe("failed");
      expect(
        (
          await f.direct.pool.query(
            "SELECT state FROM ai_analyses WHERE id=$1",
            [second.id],
          )
        ).rows[0].state,
      ).toBe("queued");
    },
    () => f.dispose(),
  );
});
