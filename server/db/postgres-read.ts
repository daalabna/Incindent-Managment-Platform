import type { Pool, PoolClient } from "pg";
import type { ActivityPage, IncidentPage } from "../../shared/contracts";
import type {
  AuditEntry,
  Incident,
  IncidentSummary,
  MonitoringEvent,
  Rule,
  Service,
} from "../../shared/domain";
import { normalizeService, refreshServices } from "../domain/apply";
import {
  incidentCursor,
  type IncidentListStatus,
} from "../domain/apply-changes";
import { DomainError } from "../domain/errors";

export type EventIdentityRow = {
  payload: MonitoringEvent | null;
  processed_at: Date | null;
  incident_id: string | null;
  failure: string | null;
};

export type EventProcessRow = EventIdentityRow & { sequence: string };

type StatsRow = {
  pending: number;
  retrying: number;
  failed: number;
  oldest_pending_age_ms: number | null;
  last_processed_at: Date | null;
};

type IncidentRow = { payload: IncidentSummary; id: string; created_at: Date };

export const readSnapshot = async (client: PoolClient) => {
  await client.query(
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  const services = await client.query<{ payload: Service }>(
    "SELECT payload FROM services ORDER BY id",
  );
  const rules = await client.query<{ payload: Rule }>(
    "SELECT payload FROM rules ORDER BY id",
  );
  const incidents = await client.query<{ payload: Incident }>(
    "SELECT payload FROM incidents ORDER BY created_at DESC, id DESC",
  );
  const audit = await client.query<{ payload: AuditEntry }>(
    "SELECT payload FROM audit_entries ORDER BY sequence DESC LIMIT 300",
  );
  const events = await client.query<{ payload: MonitoringEvent }>(
    "SELECT payload FROM monitoring_events WHERE payload IS NOT NULL AND processed_at IS NOT NULL ORDER BY sequence DESC LIMIT 200",
  );
  const sequence = await client.query<{ sequence: string }>(
    "SELECT COALESCE(MAX(sequence), 0)::bigint AS sequence FROM monitoring_events",
  );
  // Timelines are paged via /incidents/:id/timeline — snapshot keeps them empty.
  return refreshServices({
    services: services.rows.map((row) => normalizeService(row.payload)),
    rules: rules.rows.map((row) => row.payload),
    incidents: incidents.rows.map((row) => ({
      ...row.payload,
      timeline: [] as Incident["timeline"],
    })),
    audit: audit.rows.map((row) => row.payload),
    events: events.rows.map((row) => row.payload),
    receptionSequence: Number(sequence.rows[0]?.sequence ?? 0),
  });
};

export const readSummaryState = async (client: PoolClient) => {
  await client.query(
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  const services = await client.query<{ payload: Service }>(
    "SELECT payload FROM services ORDER BY id",
  );
  const rules = await client.query<{ payload: Rule }>(
    "SELECT payload FROM rules ORDER BY id",
  );
  const incidents = await client.query<{ payload: IncidentSummary }>(
    "SELECT payload - 'timeline' AS payload FROM incidents WHERE status <> 'resolved' ORDER BY created_at DESC, id DESC",
  );
  const audit = await client.query<{ payload: AuditEntry }>(
    "SELECT payload FROM audit_entries ORDER BY sequence DESC LIMIT 300",
  );
  const sequence = await client.query<{ sequence: string }>(
    "SELECT COALESCE(MAX(sequence), 0)::bigint AS sequence FROM monitoring_events",
  );
  return refreshServices({
    services: services.rows.map((row) => normalizeService(row.payload)),
    rules: rules.rows.map((row) => row.payload),
    incidents: incidents.rows.map((row) => row.payload),
    audit: audit.rows.map((row) => row.payload),
    events: [],
    receptionSequence: Number(sequence.rows[0]?.sequence ?? 0),
  });
};

export const countResolvedIncidents = async (pool: Pool) => {
  const count = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM incidents WHERE status = 'resolved'",
  );
  return count.rows[0]?.count ?? 0;
};

export const countProcessedEvents = async (pool: Pool) => {
  const count = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM monitoring_events",
  );
  return count.rows[0]?.count ?? 0;
};

/** Detail reads omit timeline; clients page via GET /incidents/:id/timeline. */
export const readIncident = async (pool: Pool, id: string) => {
  const { rows } = await pool.query<{ payload: Incident }>(
    "SELECT payload FROM incidents WHERE id=$1",
    [id],
  );
  const row = rows[0];
  if (!row) throw new DomainError("Incident not found", 404);
  return { ...row.payload, timeline: [] as Incident["timeline"] };
};

const likePattern = (value: string) =>
  `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export const listIncidentPage = async (
  pool: Pool,
  limit: number,
  cursor?: string,
  status: IncidentListStatus = "all",
  q = "",
): Promise<IncidentPage> => {
  const parsed = incidentCursor(cursor);
  const createdAt = parsed?.createdAt;
  const id = parsed?.id ?? "";
  const { rows } = await pool.query<IncidentRow>(
    `SELECT id, created_at, payload - 'timeline' AS payload
     FROM incidents
     WHERE ($1::text = 'all' OR ($1 = 'active' AND status <> 'resolved') OR ($1 = 'resolved' AND status = 'resolved'))
       AND ($2::text = '' OR id ILIKE $2 ESCAPE E'\\\\' OR payload->>'title' ILIKE $2 ESCAPE E'\\\\' OR COALESCE(payload->>'assignee', '') ILIKE $2 ESCAPE E'\\\\')
       AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4))
     ORDER BY created_at DESC, id DESC
     LIMIT $5`,
    [
      status,
      q.trim() ? likePattern(q.trim()) : "",
      createdAt || null,
      id,
      limit,
    ],
  );
  const last = rows.length === limit ? rows[rows.length - 1] : undefined;
  return {
    items: rows.map((row) => row.payload),
    nextCursor: last ? `${last.created_at.toISOString()}|${last.id}` : null,
  };
};

export const listActivity = async (
  pool: Pool,
  limit: number,
  offset = 0,
): Promise<ActivityPage> => {
  const { rows } = await pool.query<{ payload: AuditEntry }>(
    "SELECT payload FROM audit_entries ORDER BY sequence DESC LIMIT $1 OFFSET $2",
    [limit, offset],
  );
  return {
    items: rows.map((row) => row.payload),
    nextOffset: rows.length === limit ? offset + limit : null,
  };
};

export const readEventStatus = async (pool: Pool, id: string) => {
  const { rows } = await pool.query<EventIdentityRow>(
    "SELECT processed_at, incident_id, failure FROM monitoring_events WHERE id=$1",
    [id],
  );
  const row = rows[0];
  if (!row) throw new DomainError("Event not found", 404);
  return row;
};

export const readStats = async (pool: Pool) => {
  const result = await pool.query<StatsRow>(
    `SELECT
       (SELECT count(*)::int FROM event_outbox WHERE published_at IS NULL) AS pending,
       (SELECT count(*)::int FROM event_outbox WHERE published_at IS NULL AND attempts > 0) AS retrying,
       (SELECT count(*)::int FROM monitoring_events WHERE failure IS NOT NULL AND processed_at IS NULL) AS failed,
       (SELECT FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - e.received_at)) * 1000)::float8
          FROM event_outbox o
          JOIN monitoring_events e ON e.id = o.event_id
          WHERE o.published_at IS NULL
          ORDER BY e.received_at ASC
          LIMIT 1) AS oldest_pending_age_ms,
       (SELECT max(processed_at) FROM monitoring_events) AS last_processed_at`,
  );
  const row = result.rows[0];
  return {
    pending: row?.pending ?? 0,
    retrying: row?.retrying ?? 0,
    failed: row?.failed ?? 0,
    oldestPendingAgeMs: row?.oldest_pending_age_ms ?? null,
    lastProcessedAt: row?.last_processed_at
      ? row.last_processed_at.toISOString()
      : null,
  };
};
