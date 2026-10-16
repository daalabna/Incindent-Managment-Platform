import type { PoolClient } from "pg";
import type { RunbookDefinition } from "../../shared/operations";
import type { RunbookRecord } from "../domain/runbook";

export const claimDueRun = async (client: PoolClient, now: number) =>
  (
    await client.query<RunbookRecord>(
      "SELECT * FROM runbook_runs WHERE state IN ('running','compensating') AND (available_at<=$1 OR deadline_at<=$1) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
      [new Date(now)],
    )
  ).rows[0];

export const saveRun = (
  client: PoolClient,
  run: RunbookRecord,
  availableAt: number,
  error: string | null,
) =>
  client.query(
    "UPDATE runbook_runs SET state=$2,step=$3,completed=$4,context=$5,available_at=$6,error=COALESCE($7,error),version=version+1,updated_at=now() WHERE id=$1",
    [
      run.id,
      run.state,
      run.step,
      JSON.stringify(run.completed),
      run.context,
      new Date(availableAt),
      error,
    ],
  );

export const insertRunbook = (
  client: PoolClient,
  id: string,
  definition: RunbookDefinition,
) =>
  client.query("INSERT INTO runbooks(id,name,definition) VALUES($1,$2,$3)", [
    id,
    definition.name,
    definition,
  ]);

export const insertRun = (
  client: PoolClient,
  id: string,
  incidentId: string,
  definition: RunbookDefinition,
  deadlineAt: Date,
) =>
  client.query(
    "INSERT INTO runbook_runs(id,incident_id,definition,deadline_at) VALUES($1,$2,$3,$4)",
    [id, incidentId, definition, deadlineAt],
  );
