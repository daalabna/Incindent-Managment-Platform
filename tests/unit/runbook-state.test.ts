import { expect, it } from "vitest";
import type { Incident } from "../../shared/domain";
import {
  assignForRun,
  compensateAssignment,
  completedStepState,
  decideRun,
  type RunbookProgress,
} from "../../server/domain/runbook";

const waiting = (available: number, deadline: number): RunbookProgress => ({
  definition: {
    name: "wait",
    timeoutSeconds: 60,
    steps: [{ type: "wait", seconds: 30 }],
  },
  state: "running",
  step: 1,
  completed: [],
  context: {},
  available_at: new Date(available),
  deadline_at: new Date(deadline),
});
it.each([
  [100, 200, 50, "idle"],
  [100, 200, 100, "finish"],
  [100, 200, 300, "finish"],
  [200, 100, 150, "compensate"],
  [200, 100, 300, "compensate"],
  [100, 100, 100, "finish"],
] as const)(
  "wait available=%i deadline=%i at=%i => %s",
  (available, deadline, now, kind) => {
    expect(decideRun(waiting(available, deadline), now).kind).toBe(kind);
  },
);
it("preserves a completed synchronous action across a delayed worker and distinguishes final waits", () => {
  const run = waiting(100, 200);
  run.definition.steps = [{ type: "assign", assignee: "Alice" }];
  expect(decideRun(run, 300)).toEqual({ kind: "finish", state: "succeeded" });
  run.step = 0;
  expect(completedStepState(run, run.definition.steps[0]!)).toBe("succeeded");
  expect(completedStepState(run, { type: "wait", seconds: 30 })).toBe(
    "running",
  );
});
it("does not execute another step after deadline, but continues a requested cancellation", () => {
  const run = waiting(100, 200);
  run.step = 0;
  expect(decideRun(run, 300)).toEqual({
    kind: "compensate",
    outcome: "timed_out",
  });
  run.state = "compensating";
  run.context.outcome = "cancelled";
  expect(decideRun(run, 300)).toEqual({ kind: "finish", state: "cancelled" });
  run.state = "compensation_failed";
  expect(decideRun(run, 300)).toEqual({ kind: "idle" });
});

const incident = (): Incident => ({
  id: "INC-1",
  title: "Test",
  serviceId: "search-api",
  severity: "P2",
  status: "triggered",
  assignee: null,
  assigneeEpoch: 0,
  alerts: 1,
  version: 1,
  createdAt: new Date(0).toISOString(),
  resolvedAt: null,
  timeline: [],
});
it("unwinds three own assignments without mutating input snapshots", () => {
  const initial = incident();
  let value = {
    incident: initial,
    completed: [] as RunbookProgress["completed"],
  };
  for (const name of ["Alice", "Bob", "Carol"])
    value = assignForRun(value.incident, value.completed, name);
  const saved = structuredClone(value);
  for (let i = 0; i < 3; i++)
    value = compensateAssignment(value.incident, value.completed);
  expect(value.incident).toMatchObject({ assignee: null, assigneeEpoch: 6 });
  expect(value.completed).toEqual([]);
  expect(initial.assigneeEpoch).toBe(0);
  expect(saved.completed[1]!.epoch).toBe(2);
});
it("preserves assignment ownership even when a manual edit restores the same name", () => {
  const own = assignForRun(incident(), [], "Alice");
  const edited = {
    ...own.incident,
    assigneeEpoch: own.incident.assigneeEpoch + 2,
    version: own.incident.version + 2,
  };
  expect(() => assignForRun(edited, own.completed, "Bob")).toThrow(
    /Concurrent/,
  );
  expect(() => compensateAssignment(edited, own.completed)).toThrow(
    /Concurrent/,
  );
  expect(own.completed).toHaveLength(1);
  expect(() =>
    compensateAssignment(own.incident, [{ assignee: null, setTo: "Alice" }]),
  ).toThrow(/Concurrent/);
});
