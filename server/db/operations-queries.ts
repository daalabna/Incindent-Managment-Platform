import type { Pool } from "pg";
import { z } from "zod";
import {
  dependencySchema,
  failedJobSchema,
  notificationRowSchema,
  operationPage,
  runbookRowSchema,
  runbookRunSchema,
} from "../../shared/operations";
import { decodePageCursor, encodePageCursor } from "../http/page-cursor";
import { DomainError } from "../domain/errors";

const dated = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).flatMap(([key, value]) =>
      key === "cursor_at"
        ? []
        : [[key, value instanceof Date ? value.toISOString() : value]],
    ),
  );

const keyset = async <T extends z.ZodTypeAny>(
  pool: Pool,
  sql: string,
  limit: number,
  params: unknown[],
  item: T,
) => {
  const { rows } = await pool.query<
    Record<string, unknown> & {
      cursor_at: string;
      id?: string;
      event_id?: string;
      generation?: number;
    }
  >(sql, [limit + 1, ...params]);
  const page = rows.slice(0, limit);
  const last = rows.length > limit ? page[page.length - 1] : undefined;
  const nextCursor = last
    ? encodePageCursor({
        at: last.cursor_at,
        id: String(last.event_id ?? last.id),
        ...(last.generation === undefined
          ? {}
          : { generation: Number(last.generation) }),
      })
    : null;
  return operationPage(item).parse({
    items: page.map((row) => dated(row)),
    nextCursor,
  });
};

export const listFailedJobs = (
  pool: Pool,
  limit: number,
  cursor?: string,
  open?: boolean,
) => {
  const decoded = decodePageCursor(cursor);
  return keyset(
    pool,
    `SELECT event_id,generation,reason,created_at,replayed_at,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM dead_letters
      WHERE ($2::boolean IS NOT TRUE OR replayed_at IS NULL)
        AND ($3::timestamptz IS NULL OR (created_at,event_id,generation) < ($3::timestamptz,$4,$5))
      ORDER BY created_at DESC, event_id DESC, generation DESC LIMIT $1`,
    limit,
    [
      open === true,
      decoded?.at ?? null,
      decoded?.id ?? "",
      decoded?.generation ?? 0,
    ],
    failedJobSchema,
  );
};

export const getFailedJob = async (
  pool: Pool,
  eventId: string,
  generation: number,
) => {
  const row = (
    await pool.query(
      "SELECT event_id,generation,reason,created_at,replayed_at FROM dead_letters WHERE event_id=$1 AND generation=$2",
      [eventId, generation],
    )
  ).rows[0];
  if (!row) throw new DomainError("Failed job not found", 404);
  return failedJobSchema.parse(dated(row));
};

export const listDependencies = async (pool: Pool) =>
  z.object({ items: z.array(dependencySchema) }).parse({
    items: (
      await pool.query(
        "SELECT service_id,depends_on FROM service_dependencies ORDER BY service_id,depends_on",
      )
    ).rows,
  });

export const listNotifications = (
  pool: Pool,
  limit: number,
  cursor?: string,
) => {
  const decoded = decodePageCursor(cursor);
  return keyset(
    pool,
    `SELECT id,incident_id,adapter,payload,state,attempts,error,created_at,completed_at,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM notification_jobs
      WHERE ($2::timestamptz IS NULL OR (created_at,id::text) < ($2::timestamptz,$3))
      ORDER BY created_at DESC, id::text DESC LIMIT $1`,
    limit,
    [decoded?.at ?? null, decoded?.id ?? ""],
    notificationRowSchema,
  );
};

export const listRunbooks = (pool: Pool, limit: number, cursor?: string) => {
  const decoded = decodePageCursor(cursor);
  return keyset(
    pool,
    `SELECT id,name,definition,created_at,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM runbooks
      WHERE ($2::timestamptz IS NULL OR (created_at,id::text) < ($2::timestamptz,$3))
      ORDER BY created_at DESC, id::text DESC LIMIT $1`,
    limit,
    [decoded?.at ?? null, decoded?.id ?? ""],
    runbookRowSchema,
  );
};

export const listRunbookRuns = (
  pool: Pool,
  limit: number,
  cursor?: string,
  state?: string,
) => {
  const decoded = decodePageCursor(cursor);
  return keyset(
    pool,
    `SELECT id,incident_id,state,step,error,version,created_at,
      jsonb_array_length(definition->'steps') AS steps,
      to_char(available_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS available_at,
      to_char(deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline_at,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM runbook_runs
      WHERE ($2::text IS NULL OR state=$2)
        AND ($3::timestamptz IS NULL OR (created_at,id::text) < ($3::timestamptz,$4))
      ORDER BY created_at DESC, id::text DESC LIMIT $1`,
    limit,
    [state ?? null, decoded?.at ?? null, decoded?.id ?? ""],
    runbookRunSchema,
  );
};

export const getRunbookRun = async (pool: Pool, id: string) => {
  const row = (
    await pool.query<
      { definition: { steps: unknown[] } } & Record<string, unknown>
    >(
      "SELECT id,incident_id,state,step,error,version,definition,available_at,deadline_at FROM runbook_runs WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!row) throw new DomainError("Runbook run not found", 404);
  return runbookRunSchema.parse(
    dated({ ...row, steps: row.definition.steps.length }),
  );
};
