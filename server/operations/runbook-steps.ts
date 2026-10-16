import type { PoolClient } from "pg";
import type { Incident, Service } from "../../shared/domain";
import { aggregateHealth, createAudit } from "../domain/apply";
import { DomainError } from "../domain/errors";
import {
  assignForRun,
  type RunbookRecord,
  type RunbookStep,
} from "../domain/runbook";
import { saveAudit, saveIncident } from "../db/postgres-write";
import { enqueueNotification } from "./notifications";
import { RUNBOOK_WORKER } from "../security/actors";

export const executeRunbookStep = async (
  client: PoolClient,
  run: RunbookRecord,
  step: RunbookStep,
  now: number,
) => {
  if (step.type === "check_health") {
    const service = (
      await client.query<{ payload: Service }>(
        "SELECT payload FROM services WHERE id=$1",
        [step.serviceId],
      )
    ).rows[0]?.payload;
    if (!service) throw new DomainError("Runbook service not found");
    if (
      !Object.keys(service.observations ?? {}).length ||
      aggregateHealth(service, now) !== "healthy"
    )
      return { completed: false, delaySeconds: step.retrySeconds };
  }
  if (step.type === "assign") {
    const raw = (
      await client.query<{ payload: Incident }>(
        "SELECT payload FROM incidents WHERE id=$1 FOR UPDATE",
        [run.incident_id],
      )
    ).rows[0]?.payload;
    if (!raw) throw new DomainError("Incident not found");
    const incident = { ...raw, timeline: [] };
    const next = assignForRun(incident, run.completed, step.assignee);
    const entry = createAudit(
      `Runbook ${run.id}: assigned to ${step.assignee}`,
      RUNBOOK_WORKER,
      next.incident,
    );
    await saveIncident(client, next.incident);
    await saveAudit(client, [entry]);
    run.completed = next.completed;
  }
  if (step.type === "notify")
    await enqueueNotification(
      client,
      run.incident_id,
      step.text,
      `runbook:${run.id}:${run.step}`,
    );
  await saveAudit(client, [
    createAudit(
      `Runbook ${run.id} step ${run.step + 1}: ${step.type}${step.type === "note" ? ": " + step.text : ""}`,
      RUNBOOK_WORKER,
    ),
  ]);
  return {
    completed: true,
    delaySeconds: step.type === "wait" ? step.seconds : 0,
  };
};
