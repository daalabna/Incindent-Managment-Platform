import type { Incident } from "../../shared/domain";
import type { RunbookDefinition, RunState } from "../../shared/operations";
import { DomainError } from "./errors";

export type RunbookStep = RunbookDefinition["steps"][number];
export type RunOutcome = "failed" | "cancelled" | "timed_out";
/** Optional epochs retain the persisted legacy format; unknown ownership fails closed. */
export type AssignmentUndo = {
  assignee: string | null;
  setTo: string;
  epoch?: number;
  baseEpoch?: number;
};
export type RunbookProgress = {
  definition: RunbookDefinition;
  state: RunState;
  step: number;
  completed: AssignmentUndo[];
  context: { outcome?: RunOutcome };
  available_at: Date;
  deadline_at: Date;
};
export type RunbookRecord = RunbookProgress & {
  id: string;
  incident_id: string;
  version: number;
};
export type RunDecision =
  | { kind: "idle" }
  | { kind: "finish"; state: "succeeded" | RunOutcome }
  | { kind: "compensate"; outcome: RunOutcome }
  | { kind: "step"; step: RunbookStep };

/** Pure decision: scheduler delays cannot turn an expired wait into success. */
export const decideRun = (run: RunbookProgress, now: number): RunDecision => {
  if (run.state === "compensating") {
    const outcome = run.context.outcome ?? "failed";
    return run.completed.length
      ? { kind: "compensate", outcome }
      : { kind: "finish", state: outcome };
  }
  if (run.state !== "running") return { kind: "idle" };
  const available = run.available_at.getTime();
  const deadline = run.deadline_at.getTime();
  if (run.step >= run.definition.steps.length && available <= now) {
    const last = run.definition.steps[run.step - 1];
    return last?.type === "wait" && deadline < available
      ? { kind: "compensate", outcome: "timed_out" }
      : { kind: "finish", state: "succeeded" };
  }
  if (deadline <= now) return { kind: "compensate", outcome: "timed_out" };
  if (available > now) return { kind: "idle" };
  const step = run.definition.steps[run.step];
  return step ? { kind: "step", step } : { kind: "finish", state: "succeeded" };
};

export const completedStepState = (
  run: RunbookProgress,
  step: RunbookStep,
): RunState =>
  run.step + 1 >= run.definition.steps.length && step.type !== "wait"
    ? "succeeded"
    : "running";

export const assignmentConflict =
  "Concurrent incident edit; compensation needs operator review";

/**
 * Compensation undoes assign steps only (assignee + epoch).
 * notify/check_health/wait/note are not reversed — operator must handle side effects.
 */
export const assignForRun = (
  incident: Incident,
  completed: AssignmentUndo[],
  assignee: string,
) => {
  const baseEpoch = incident.assigneeEpoch ?? 0;
  const last = completed.at(-1);
  if (last && last.epoch !== baseEpoch)
    throw new DomainError(assignmentConflict);
  const updated = {
    ...incident,
    timeline: [...incident.timeline],
    assignee,
    assigneeEpoch: baseEpoch + 1,
    version: incident.version + 1,
  };
  return {
    incident: updated,
    completed: [
      ...completed,
      {
        assignee: incident.assignee,
        setTo: assignee,
        epoch: updated.assigneeEpoch,
        baseEpoch,
      },
    ],
  };
};

export const compensateAssignment = (
  incident: Incident | undefined,
  completed: AssignmentUndo[],
) => {
  const undo = completed.at(-1);
  const epoch = incident?.assigneeEpoch ?? 0;
  if (
    !incident ||
    !undo ||
    incident.assignee !== undo.setTo ||
    undo.epoch !== epoch
  )
    throw new DomainError(assignmentConflict);
  const updated = {
    ...incident,
    timeline: [...incident.timeline],
    assignee: undo.assignee,
    assigneeEpoch: epoch + 1,
    version: incident.version + 1,
  };
  const remaining = completed.slice(0, -1).map((item) => ({ ...item }));
  const next = remaining.at(-1);
  const base = undo.baseEpoch ?? undo.epoch - 1;
  if (next && next.epoch === base) next.epoch = updated.assigneeEpoch;
  return { incident: updated, completed: remaining };
};
