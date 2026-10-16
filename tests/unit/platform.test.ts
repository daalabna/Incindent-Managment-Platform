import { expect, it } from "vitest";
import { applyIngest } from "../../server/domain/apply";
import { DomainState } from "../../server/domain/domain";
import { matchesAggregate, windowStart } from "../../server/domain/windows";
import { runbookSchema } from "../../shared/operations";
import type { Rule } from "../../shared/domain";
import {
  decodePageCursor,
  encodePageCursor,
} from "../../server/http/page-cursor";
import {
  passwordHash,
  requestPathname,
  requiresAdministrator,
} from "../../server/security/auth";
const rule: Rule = {
  id: "window",
  serviceId: "search-api",
  metric: "latency",
  threshold: 100,
  severity: "P2",
  enabled: true,
  windowSeconds: 60,
  minSamples: 2,
};
it("requires enough samples and distinguishes average, maximum and sustained breaches", () => {
  const sample = (values: number[]) => ({
    samples: values.length,
    maximum: Math.max(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    sustained: values.every((value) => value > rule.threshold),
  });
  expect(matchesAggregate(sample([200]), rule)).toBe(false);
  expect(matchesAggregate(sample([0, 150]), rule)).toBe(false);
  expect(
    matchesAggregate(sample([0, 150]), { ...rule, aggregation: "max" }),
  ).toBe(true);
  expect(
    matchesAggregate(
      { ...sample([0, 150]), sustained: false },
      { ...rule, aggregation: "all" },
    ),
  ).toBe(false);
  expect(
    matchesAggregate(
      { ...sample([101, 150]), sustained: true },
      { ...rule, aggregation: "all" },
    ),
  ).toBe(true);
  expect(windowStart(129999, 60)).toBe(120000);
});
it("rejects unbounded and executable runbook steps", () => {
  expect(
    runbookSchema.safeParse({
      name: "bad",
      steps: [{ type: "shell", command: "anything" }],
    }).success,
  ).toBe(false);
  expect(
    runbookSchema.safeParse({
      name: "bad",
      steps: [{ type: "wait", seconds: 999999 }],
    }).success,
  ).toBe(false);
});
it("keeps administrator checks on the path when a query string is added", () => {
  expect(requestPathname("/api/runbooks?probe=1")).toBe("/api/runbooks");
  expect(requestPathname("/api/runbooks/?x=1")).toBe("/api/runbooks/");
  expect(requiresAdministrator(requestPathname("/api/runbooks?probe=1"))).toBe(
    true,
  );
  expect(requiresAdministrator("/api/runbooks/")).toBe(true);
  expect(requiresAdministrator("/api/runbook-runs")).toBe(false);
  expect(requiresAdministrator("/api/runbook-runs?probe=1")).toBe(false);
  expect(requiresAdministrator("/api/rules")).toBe(true);
});
it("keeps a newer event-time observation that was accepted earlier", () => {
  const state = new DomainState().state;
  const now = Date.now();
  const stamp = (delta: number) => new Date(now + delta).toISOString();
  applyIngest(
    state,
    {
      id: "older",
      source: "payments",
      type: "latency",
      value: 10,
      timestamp: stamp(-10000),
    },
    2,
    now,
    { eventTime: true },
  );
  applyIngest(
    state,
    {
      id: "newer",
      source: "payments",
      type: "latency",
      value: 2000,
      timestamp: stamp(0),
    },
    1,
    now,
    { eventTime: true },
  );
  expect(
    state.services.find((service) => service.id === "payments")?.latency,
  ).toBe(2000);
  applyIngest(
    state,
    {
      id: "tie",
      source: "payments",
      type: "latency",
      value: 1,
      timestamp: stamp(0),
    },
    1,
    now,
    { eventTime: true },
  );
  expect(
    state.services.find((service) => service.id === "payments")?.latency,
  ).toBe(2000);
});
it("keeps microseconds and pipes inside an operations cursor", () => {
  const cursor = encodePageCursor({
    at: "2026-10-01T00:00:00.123456Z",
    id: "event|part",
    generation: 2,
  });
  expect(cursor.includes("|")).toBe(false);
  expect(decodePageCursor(cursor)).toEqual({
    at: "2026-10-01T00:00:00.123456Z",
    id: "event|part",
    generation: 2,
  });
});
it("salts identical passwords independently", async () => {
  const a = await passwordHash("a-password-for-testing");
  const b = await passwordHash("a-password-for-testing");
  expect(a).not.toBe(b);
  expect(a).not.toContain("password");
});
