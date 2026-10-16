import { expect, it } from "vitest";
import { healthResponseSchema } from "../../shared/contracts";
import { encodeHealth } from "../../server/runtime/worker-health";

it("returns a schema-valid degraded report when health cannot be read", () => {
  const encoded = encodeHealth(undefined);
  expect(encoded.statusCode).toBe(503);
  expect(encoded.body).toEqual({
    status: "degraded",
    mode: "distributed",
    storage: "postgresql",
    postgres: { status: "down" },
    redis: { status: "down" },
    rabbitmq: { status: "down" },
    ai: {
      status: "disabled",
      connected: false,
      consumers: 0,
      queued: null,
      oldestQueuedMs: null,
    },
  });
  expect(healthResponseSchema.safeParse(encoded.body).success).toBe(true);
});

it("keeps a successful distributed health report", () => {
  const encoded = encodeHealth({
    status: "ok",
    mode: "distributed",
    storage: "postgresql",
    postgres: {
      status: "up",
      outbox: {
        pending: 0,
        retrying: 0,
        failed: 0,
        oldestPendingAgeMs: null,
        lastProcessedAt: null,
      },
    },
    redis: { status: "up" },
    rabbitmq: {
      status: "up",
      connected: true,
      consumers: 1,
      queued: 0,
      dead: 0,
    },
    ai: {
      status: "disabled",
      connected: false,
      consumers: 0,
      queued: null,
      oldestQueuedMs: null,
    },
  });
  expect(encoded.statusCode).toBe(200);
  expect(encoded.body).toMatchObject({ status: "ok", mode: "distributed" });
});
