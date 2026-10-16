import type { Pool, PoolClient } from "pg";
import type { Incident, TimelineEntry } from "../../shared/domain";
import { DomainError } from "../domain/errors";

export const saveTimelineEntries = async (
  client: PoolClient,
  incidentId: string,
  entries: TimelineEntry[],
) => {
  if (!entries.length) return;
  await client.query(
    `INSERT INTO incident_timeline(id, incident_id, at, actor, text)
     SELECT e.id, $1, e.at, e.actor, e.text
     FROM jsonb_to_recordset($2::jsonb) AS e(id uuid, at timestamptz, actor text, text text)
     ON CONFLICT (id) DO NOTHING`,
    [incidentId, JSON.stringify(entries)],
  );
};

export type TimelinePageCursor = { at: string; sequence: string };

/** Encode/decode composite cursor (at|sequence) for DESC (at, sequence) pagination. */
export const encodeTimelineCursor = (at: string, sequence: string | number) =>
  `${at}|${String(sequence)}`;

export const decodeTimelineCursor = (cursor: string): TimelinePageCursor => {
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0) throw new DomainError("Invalid timeline cursor", 400);
  const at = cursor.slice(0, separator);
  const sequence = cursor.slice(separator + 1);
  const stamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(
    at,
  );
  const millis = stamp
    ? `${stamp[1]}.${(stamp[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`
    : "";
  if (
    !stamp ||
    !/^\d{1,19}$/.test(sequence) ||
    BigInt(sequence) < 1n ||
    BigInt(sequence) > 9223372036854775807n ||
    !Number.isFinite(Date.parse(millis)) ||
    new Date(millis).toISOString() !== millis
  )
    throw new DomainError("Invalid timeline cursor", 400);
  return { at, sequence };
};

export const readTimelinePage = async (
  pool: Pool | PoolClient,
  incidentId: string,
  limit = 50,
  before?: TimelinePageCursor,
) => {
  const { rows } = await pool.query<{
    sequence: string;
    id: string;
    at: string;
    actor: string;
    text: string;
  }>(
    `SELECT t.sequence::text AS sequence, id,
       to_char(t.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
       actor, text FROM incident_timeline t
     WHERE incident_id=$1 AND (
       $2::timestamptz IS NULL
       OR (at, sequence) < ($2::timestamptz, $3::bigint)
     )
     ORDER BY t.at DESC, t.sequence DESC LIMIT $4`,
    [incidentId, before?.at ?? null, before?.sequence ?? null, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    actor: row.actor,
    text: row.text,
    sequence: row.sequence,
  }));
};

export const readTimelineEntries = async (
  pool: Pool | PoolClient,
  incidentId: string,
  limit?: number,
): Promise<TimelineEntry[]> => {
  const { rows } = await pool.query<{
    id: string;
    at: Date;
    actor: string;
    text: string;
  }>(
    limit == null
      ? `SELECT id, at, actor, text FROM incident_timeline
         WHERE incident_id=$1 ORDER BY at ASC, sequence ASC`
      : `SELECT id, at, actor, text FROM (
           SELECT id, at, actor, text, sequence FROM incident_timeline
           WHERE incident_id=$1 ORDER BY at DESC, sequence DESC LIMIT $2
         ) recent ORDER BY at ASC, sequence ASC`,
    limit == null ? [incidentId] : [incidentId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    at: row.at.toISOString(),
    actor: row.actor,
    text: row.text,
  }));
};

/** One query for many incidents — never parallelize queries on one PoolClient. */
export const hydrateIncidentsTimelines = async (
  pool: Pool | PoolClient,
  incidents: Incident[],
): Promise<Incident[]> => {
  if (!incidents.length) return incidents;
  const { rows } = await pool.query<{
    incident_id: string;
    id: string;
    at: Date;
    actor: string;
    text: string;
  }>(
    `SELECT incident_id, id, at, actor, text FROM incident_timeline
     WHERE incident_id = ANY($1::text[])
     ORDER BY incident_id, at ASC, sequence ASC`,
    [incidents.map((item) => item.id)],
  );
  const byId = new Map<string, TimelineEntry[]>();
  for (const row of rows) {
    const list = byId.get(row.incident_id) ?? [];
    list.push({
      id: row.id,
      at: row.at.toISOString(),
      actor: row.actor,
      text: row.text,
    });
    byId.set(row.incident_id, list);
  }
  // Table is SoT after 006/007 backfill+strip; never fall back to payload.timeline.
  return incidents.map((incident) => ({
    ...incident,
    timeline: byId.get(incident.id) ?? [],
  }));
};

/** Table is source of truth; empty table means empty timeline. */
export const hydrateIncidentTimeline = async (
  pool: Pool | PoolClient,
  incident: Incident,
): Promise<Incident> => {
  const [hydrated] = await hydrateIncidentsTimelines(pool, [incident]);
  return hydrated ?? incident;
};
