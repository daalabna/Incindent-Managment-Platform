import { expect, it, vi } from "vitest";
import { DomainError } from "../../server/domain/errors";
import type { ChangeNotice } from "../../server/broker/redis";
import { createIsolated, withCleanup } from "../support/isolated-infra";
import { event, processed } from "./helpers";

it("keeps an event pending when publication throws, then delivers it from a worker", async () => {
  const isolated = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await isolated.direct.accept(input);
      const notes = await isolated.direct.publishPending(async () => {
        throw new Error("simulated broker outage");
      });
      expect(notes[0]).toMatch(/eventId=/);
      expect((await isolated.direct.stats()).pending).toBe(1);
      expect((await isolated.direct.eventStatus(input.id)).status).toBe(
        "queued",
      );
      const { app } = await isolated.startApi();
      expect((await app.inject("/api/health")).statusCode).toBe(503);
      await isolated.startWorker();
      await processed(isolated.direct, input.id);
      expect((await isolated.direct.snapshot()).incidents).toHaveLength(1);
      expect((await app.inject("/api/health")).statusCode).toBe(200);
      const health = (await app.inject("/api/health")).json();
      expect(health.postgres.outbox).toMatchObject({ pending: 0, failed: 0 });
      expect(health.postgres.outbox.lastProcessedAt).toEqual(
        expect.any(String),
      );
    },
    () => isolated.dispose(),
  );
});

it("validates events, deduplicates a completed redelivery, and rejects ID reuse", async () => {
  const isolated = await createIsolated();
  await withCleanup(
    async () => {
      const { app, api } = await isolated.startApi();
      const worker = await isolated.startWorker();
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/events",
            payload: { source: "search-api", type: "latency", value: -1 },
          })
        ).statusCode,
      ).toBe(400);
      const input = event({ type: "latency", value: 1800 });
      const response = await app.inject({
        method: "POST",
        url: "/api/events",
        payload: input,
      });
      expect(response.statusCode).toBe(202);
      expect(response.json().status).toBe("queued");
      await processed(isolated.direct, input.id);
      const before = (await isolated.direct.snapshot()).incidents[0]?.alerts;
      await worker.rabbit.publish(input.id);
      const barrier = event({ type: "latency", value: 10 });
      await api.ingest(barrier);
      await processed(isolated.direct, barrier.id);
      const duplicate = await app.inject({
        method: "POST",
        url: "/api/events",
        payload: input,
      });
      expect(duplicate.json()).toMatchObject({
        duplicate: true,
        status: "processed",
      });
      const conflicting = await app.inject({
        method: "POST",
        url: "/api/events",
        payload: { ...input, value: 1900 },
      });
      expect(conflicting.statusCode).toBe(409);
      expect((await isolated.direct.snapshot()).incidents[0]?.alerts).toBe(
        before,
      );
    },
    () => isolated.dispose(),
  );
});

it("serializes concurrent correlation and rejects a stale operator update", async () => {
  const isolated = await createIsolated();
  await withCleanup(
    async () => {
      const { app } = await isolated.startApi();
      const first = event();
      await isolated.direct.accept(first);
      await isolated.direct.processEvent(first.id);
      const before =
        (await isolated.direct.snapshot()).incidents[0]?.alerts ?? 0;
      const inputs = Array.from({ length: 8 }, () => event());
      await Promise.all(inputs.map((item) => isolated.direct.accept(item)));
      await Promise.all(
        inputs.map((item) => isolated.direct.processEvent(item.id)),
      );
      const incidents = (await isolated.direct.snapshot()).incidents;
      expect(incidents).toHaveLength(1);
      expect(incidents[0]?.alerts).toBe(before + 8);
      const incident = incidents[0];
      if (!incident) throw new Error("missing incident");
      const responses = await Promise.all(
        ["Alice", "Bob"].map((assignee) =>
          app.inject({
            method: "PATCH",
            url: `/api/incidents/${incident.id}`,
            payload: { version: incident.version, assignee },
          }),
        ),
      );
      expect(responses.map((response) => response.statusCode).sort()).toEqual([
        200, 409,
      ]);
    },
    () => isolated.dispose(),
  );
});

it("uses Redis for one cross-process invalidation and token-owned simulation locks", async () => {
  const isolated = await createIsolated();
  const delivered: ChangeNotice[] = [];
  let socket: WebSocket | undefined;
  await withCleanup(
    async () => {
      const worker = await isolated.startWorker((notice) => {
        delivered.push(notice);
      });
      const { app, api } = await isolated.startApi();
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string")
        throw new Error("API did not bind a port");
      socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      const frames: string[] = [];
      socket.addEventListener("message", () => frames.push("frame"));
      await new Promise<void>((resolve, reject) => {
        socket?.addEventListener("open", () => resolve(), { once: true });
        socket?.addEventListener(
          "error",
          () => reject(new Error("WebSocket failed")),
          { once: true },
        );
      });
      await api.addRule({
        serviceId: "payments",
        metric: "latency",
        threshold: 1000,
        severity: "P2",
        enabled: true,
      });
      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1);
        expect(frames).toHaveLength(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(delivered[0]).toMatchObject({
        scopes: ["summary", "activity"],
        incidentId: null,
      });
      expect(frames).toHaveLength(1);
      const token = await api.acquireSimulation();
      expect(token).toBeTruthy();
      expect(await worker.acquireSimulation()).toBeNull();
      await worker.releaseSimulation("wrong-token");
      expect(await worker.acquireSimulation()).toBeNull();
      expect(await api.renewSimulation(token!)).toBe(true);
      await api.releaseSimulation(token!);
      const next = await worker.acquireSimulation();
      expect(next).toBeTruthy();
      await worker.releaseSimulation(next!);
    },
    async () => {
      socket?.close();
      await isolated.dispose();
    },
  );
});

it("retries transient worker failures and dead-letters an invalid message", async () => {
  const isolated = await createIsolated();
  await withCleanup(
    async () => {
      const { api, app } = await isolated.startApi();
      const worker = await isolated.startWorker();
      const input = event({ source: "payments" });
      const original = worker.store.processDelivery.bind(worker.store);
      let failures = 0;
      const spy = vi
        .spyOn(worker.store, "processDelivery")
        .mockImplementation(async (id, generation) => {
          if (id === input.id && failures++ < 2)
            throw new Error("temporary DB failure");
          return original(id, generation);
        });
      try {
        await api.ingest(input);
        await processed(isolated.direct, input.id);
        expect(failures).toBe(3);
      } finally {
        spy.mockRestore();
      }
      await worker.rabbit.publish("missing-event");
      await vi.waitFor(async () =>
        expect((await worker.rabbit.health()).dead).toBe(1),
      );
      const poison = event({ source: "payments" });
      const terminal = vi
        .spyOn(worker.store, "processDelivery")
        .mockRejectedValue(new DomainError("terminal failure"));
      try {
        await api.ingest(poison);
        await vi.waitFor(async () =>
          expect((await isolated.direct.eventStatus(poison.id)).status).toBe(
            "failed",
          ),
        );
        await vi.waitFor(async () =>
          expect((await worker.rabbit.health()).dead).toBe(2),
        );
        const duplicate = await app.inject({
          method: "POST",
          url: "/api/events",
          payload: poison,
        });
        expect(duplicate.statusCode).toBe(202);
        expect(duplicate.json()).toMatchObject({
          duplicate: true,
          status: "failed",
          error: "Processing failed after retries; inspect dead-letter queue",
        });
      } finally {
        terminal.mockRestore();
      }
    },
    () => isolated.dispose(),
  );
});

it("reconnects a closed publisher and preserves queued work across worker restart", async () => {
  const isolated = await createIsolated();
  await withCleanup(
    async () => {
      const { api } = await isolated.startApi();
      let worker = await isolated.startWorker();
      const previous = api.rabbit.connection;
      await previous?.close();
      const input = event({ source: "payments" });
      await api.ingest(input);
      await processed(isolated.direct, input.id);
      await vi.waitFor(
        () =>
          expect(
            api.rabbit.connected && api.rabbit.connection !== previous,
          ).toBe(true),
        { timeout: 10000 },
      );
      await worker.close();
      const waiting = event({ source: "payments" });
      await api.ingest(waiting);
      expect((await isolated.direct.eventStatus(waiting.id)).status).toBe(
        "queued",
      );
      worker = await isolated.startWorker();
      await processed(isolated.direct, waiting.id);
      expect((await isolated.direct.snapshot()).incidents).toHaveLength(1);
    },
    () => isolated.dispose(),
  );
});
