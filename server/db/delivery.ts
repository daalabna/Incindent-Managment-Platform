import type { PoolClient } from "pg";
import { createAudit } from "../domain/apply";
import { DomainError } from "../domain/errors";
import { saveAudit } from "./postgres-write";
import { deliveryBudget } from "./delivery-budget";
import { advisoryLockSql } from "./locks";

export { deliveryBudget };

export const beginDelivery = async (
  client: PoolClient,
  id: string,
  generation: number,
) => {
  // Same lock order as retention/ingest: advisory events, then row FOR UPDATE.
  await client.query(advisoryLockSql("events"));
  const { rows } = await client.query<{
    attempts: number;
    generation: number;
    terminal_at: Date | null;
    processed_at: Date | null;
    deadline_at: Date;
  }>(
    "SELECT attempts,generation,terminal_at,processed_at,deadline_at FROM monitoring_events WHERE id=$1 FOR UPDATE",
    [id],
  );
  const row = rows[0];
  if (!row) throw new DomainError("Queued event does not exist", 404);
  if (row.generation !== generation || row.processed_at) return false;
  if (row.terminal_at) return "terminal" as const;
  if (
    row.attempts >= deliveryBudget.maxAttempts ||
    row.deadline_at.getTime() <= Date.now()
  )
    throw new DomainError("Delivery retry budget exhausted");
  await client.query(
    "UPDATE monitoring_events SET attempts=attempts+1 WHERE id=$1",
    [id],
  );
  return true;
};

export const terminalDelivery = async (
  client: PoolClient,
  id: string,
  generation: number | null,
  reason: string,
) => {
  await client.query(advisoryLockSql("events"));
  const { rows } = await client.query<{
    processed_at: Date | null;
    generation: number;
  }>(
    "SELECT processed_at,generation FROM monitoring_events WHERE id=$1 FOR UPDATE",
    [id],
  );
  const row = rows[0];
  if (!row || row.processed_at) return;
  const gen = generation === null ? row.generation : generation;
  if (row.generation !== gen) return;
  await client.query(
    "INSERT INTO dead_letters(event_id,generation,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [id, gen, reason.slice(0, 500)],
  );
  await client.query(
    "UPDATE monitoring_events SET failure=$2,terminal_at=now() WHERE id=$1",
    [id, reason.slice(0, 500)],
  );
};

export const replayDelivery = async (
  client: PoolClient,
  id: string,
  generation: number,
  actor: string,
  reason: string,
) => {
  await client.query(advisoryLockSql("events"));
  const { rows } = await client.query<{
    generation: number;
    terminal_at: Date | null;
  }>(
    "SELECT generation,terminal_at FROM monitoring_events WHERE id=$1 FOR UPDATE",
    [id],
  );
  const row = rows[0];
  if (!row) throw new DomainError("Event not found", 404);
  if (!row.terminal_at || row.generation !== generation)
    throw new DomainError("Replay conflict: refresh failed jobs", 409);
  if (generation >= deliveryBudget.maxReplays)
    throw new DomainError("Replay budget exhausted", 409);
  await client.query(
    "UPDATE dead_letters SET replayed_at=now() WHERE event_id=$1 AND generation=$2",
    [id, generation],
  );
  await client.query(
    "UPDATE monitoring_events SET generation=generation+1,attempts=0,terminal_at=NULL,failure=NULL,deadline_at=now()+($2::int * interval '1 millisecond') WHERE id=$1",
    [id, deliveryBudget.maxAgeMs],
  );
  await client.query(
    "INSERT INTO event_outbox(event_id) VALUES($1) ON CONFLICT(event_id) DO UPDATE SET published_at=NULL,attempts=0,last_error=NULL",
    [id],
  );
  await saveAudit(client, [
    createAudit(
      `DLQ replay ${id} generation ${generation + 1}: ${reason}`,
      actor,
    ),
  ]);
  return { eventId: id, generation: generation + 1, status: "queued" as const };
};
