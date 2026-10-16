import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Incident } from "../../shared/domain";
import { runbookSchema, type RunbookDefinition } from "../../shared/operations";
import { createAudit } from "../domain/apply";
import { DomainError } from "../domain/errors";
import {
  compensateAssignment,
  completedStepState,
  decideRun,
} from "../domain/runbook";
import { saveAudit, saveIncident } from "../db/postgres-write";
import { claimDueRun, insertRun, saveRun } from "../db/runbooks";
import type { PostgresStore } from "../db/postgres";
import { executeRunbookStep } from "./runbook-steps";
import { RUNBOOK_WORKER } from "../security/actors";

const audit = (client: PoolClient, text: string) =>
  saveAudit(client, [createAudit(text, RUNBOOK_WORKER)]);

export const startRun = async (
  client: PoolClient,
  runbookId: string,
  incidentId: string,
  actor: string,
) => {
  const book = (
    await client.query<{ definition: RunbookDefinition }>(
      "SELECT definition FROM runbooks WHERE id=$1",
      [runbookId],
    )
  ).rows[0];
  if (!book) throw new DomainError("Runbook not found", 404);
  if (
    !(
      await client.query("SELECT id FROM incidents WHERE id=$1 FOR UPDATE", [
        incidentId,
      ])
    ).rowCount
  )
    throw new DomainError("Incident not found", 404);
  const active = await client.query(
    "SELECT id FROM runbook_runs WHERE incident_id=$1 AND state IN ('running','compensating') LIMIT 1",
    [incidentId],
  );
  if (active.rowCount)
    throw new DomainError("A runbook is already active for this incident", 409);
  const definition = runbookSchema.parse(book.definition);
  const id = randomUUID();
  await insertRun(
    client,
    id,
    incidentId,
    definition,
    new Date(Date.now() + definition.timeoutSeconds * 1000),
  );
  await saveAudit(client, [
    createAudit(`Runbook ${id} started for ${incidentId}`, actor),
  ]);
  return { id, state: "running" };
};

export const cancelRun = async (
  client: PoolClient,
  id: string,
  version: number,
  actor: string,
) => {
  const result = await client.query(
    "UPDATE runbook_runs SET state='compensating',context=jsonb_build_object('outcome','cancelled'),available_at=now(),version=version+1 WHERE id=$1 AND version=$2 AND state='running' RETURNING id",
    [id, version],
  );
  if (!result.rowCount)
    throw new DomainError("Run already changed or completed", 409);
  await saveAudit(client, [
    createAudit(`Runbook ${id} cancellation requested`, actor),
  ]);
  return { id, state: "compensating" };
};

/** One locked transition and its side effects commit together. */
export const runbookTick = (store: PostgresStore, now = Date.now()) =>
  store.transaction(async (client) => {
    const run = await claimDueRun(client, now);
    if (!run) return;
    const decision = decideRun(run, now);
    if (decision.kind === "idle") return;
    let delaySeconds = 0;
    let error: string | null = null;
    if (decision.kind === "finish") run.state = decision.state;
    else if (decision.kind === "compensate") {
      run.state = "compensating";
      run.context = { outcome: decision.outcome };
      if (!run.completed.length) run.state = decision.outcome;
      else {
        const raw = (
          await client.query<{ payload: Incident }>(
            "SELECT payload FROM incidents WHERE id=$1 FOR UPDATE",
            [run.incident_id],
          )
        ).rows[0]?.payload;
        try {
          const incident = raw ? { ...raw, timeline: [] } : undefined;
          const next = compensateAssignment(incident, run.completed);
          const entry = createAudit(
            `Runbook ${run.id}: assignment compensated`,
            RUNBOOK_WORKER,
            next.incident,
          );
          await saveIncident(client, next.incident);
          await saveAudit(client, [entry]);
          run.completed = next.completed;
        } catch (failure) {
          if (!(failure instanceof DomainError)) throw failure;
          run.state = "compensation_failed";
          error = failure.message;
        }
      }
    } else {
      try {
        const effect = await executeRunbookStep(
          client,
          run,
          decision.step,
          now,
        );
        delaySeconds = effect.delaySeconds;
        if (effect.completed) {
          run.state = completedStepState(run, decision.step);
          run.step++;
        }
      } catch (failure) {
        if (!(failure instanceof DomainError)) throw failure;
        error = failure.message;
        run.state = "compensating";
        run.context = { outcome: "failed" };
      }
    }
    await saveRun(client, run, now + delaySeconds * 1000, error);
    if (run.state !== "running" && run.state !== "compensating")
      await audit(client, `Runbook ${run.id} ${run.state}`);
  });
