import type { PoolClient } from "pg";
import type { IncidentPatch } from "../../shared/contracts";
import type {
  AuditEntry,
  Incident,
  MonitoringEvent,
  Rule,
  Service,
  Snapshot,
} from "../../shared/domain";
import {
  applyAddRule,
  applyToggleRule,
  applyUpdate,
  normalizeService,
} from "../domain/apply";
import { deliveryReceipt } from "../domain/delivery";
import { DomainError, redact } from "../domain/errors";
import type { EventIdentityRow } from "./postgres-read";
import { traceHeaders } from "../observability/telemetry";
import { deliveryBudget } from "./delivery-budget";
import { saveTimelineEntries } from "./incident-timeline";

export const saveIncident = async (client: PoolClient, incident: Incident) => {
  // Timeline lives only in incident_timeline; payload keeps an empty array for schema compat.
  const stored = { ...incident, timeline: [] as Incident["timeline"] };
  await client.query(
    "INSERT INTO incidents(id,service_id,version,status,created_at,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,status=EXCLUDED.status,payload=EXCLUDED.payload",
    [
      stored.id,
      stored.serviceId,
      stored.version,
      stored.status,
      stored.createdAt,
      stored,
    ],
  );
  await saveTimelineEntries(client, incident.id, incident.timeline);
};

export const saveRule = async (client: PoolClient, rule: Rule) => {
  await client.query(
    "INSERT INTO rules(id,service_id,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload",
    [rule.id, rule.serviceId, rule],
  );
};

export const saveAudit = async (client: PoolClient, entries: AuditEntry[]) => {
  for (const entry of [...entries].reverse())
    await client.query(
      "INSERT INTO audit_entries(id,incident_id,payload) VALUES($1,$2,$3)",
      [entry.id, entry.incidentId, entry],
    );
};

export const acceptEvent = async (
  client: PoolClient,
  event: MonitoringEvent,
) => {
  if (
    !(await client.query("SELECT id FROM services WHERE id=$1", [event.source]))
      .rowCount
  )
    throw new DomainError("Unknown event source", 404);
  const inserted = await client.query(
    "INSERT INTO monitoring_events(id, service_id, payload,trace_context,deadline_at) VALUES($1,$2,$3,$4,now()+($5::int * interval '1 millisecond')) ON CONFLICT(id) DO NOTHING RETURNING id",
    [event.id, event.source, event, traceHeaders(), deliveryBudget.maxAgeMs],
  );
  if (!inserted.rowCount) {
    const existing = await client.query<EventIdentityRow>(
      "SELECT COALESCE(payload,fingerprint) AS payload, processed_at, incident_id, failure FROM monitoring_events WHERE id=$1",
      [event.id],
    );
    const previous = existing.rows[0];
    if (!previous) throw new DomainError("Event not found", 404);
    if (
      previous.payload &&
      (previous.payload.source !== event.source ||
        previous.payload.type !== event.type ||
        previous.payload.value !== event.value)
    )
      throw new DomainError(
        "Event ID already belongs to a different event",
        409,
      );
    return deliveryReceipt(event.id, previous, true);
  }
  await client.query("INSERT INTO event_outbox(event_id) VALUES($1)", [
    event.id,
  ]);
  return deliveryReceipt(
    event.id,
    { processed_at: null, incident_id: null, failure: null },
    false,
  );
};

export const updateIncident = async (
  client: PoolClient,
  id: string,
  version: number,
  patch: IncidentPatch,
  actor: string,
) => {
  const { rows } = await client.query<{ payload: Incident }>(
    "SELECT payload FROM incidents WHERE id=$1 FOR UPDATE",
    [id],
  );
  const current = rows[0];
  if (!current) throw new DomainError("Incident not found", 404);
  // Apply without loading full history — only new timeline rows are inserted.
  const loaded = {
    ...current.payload,
    timeline: [] as Incident["timeline"],
  };
  const state: Snapshot = {
    services: [],
    rules: [],
    incidents: [loaded],
    audit: [],
    events: [],
    receptionSequence: 0,
  };
  const incident = applyUpdate(state, id, version, patch, actor);
  await saveIncident(client, incident);
  await saveAudit(client, state.audit);
  // Only rows inserted by this patch — full history is on /timeline.
  return incident;
};

export const addStoredRule = async (
  client: PoolClient,
  rule: Omit<Rule, "id">,
  actor: string,
) => {
  const services = await client.query<{ payload: Service }>(
    "SELECT payload FROM services WHERE id=$1",
    [rule.serviceId],
  );
  const state: Snapshot = {
    services: services.rows.map((item) => normalizeService(item.payload)),
    incidents: [],
    rules: [],
    events: [],
    audit: [],
    receptionSequence: 0,
  };
  const result = applyAddRule(state, rule, actor);
  await saveRule(client, result);
  await saveAudit(client, state.audit);
  return result;
};

export const toggleStoredRule = async (
  client: PoolClient,
  id: string,
  enabled: boolean,
  actor: string,
) => {
  const rules = await client.query<{ payload: Rule }>(
    "SELECT payload FROM rules WHERE id=$1 FOR UPDATE",
    [id],
  );
  const state: Snapshot = {
    services: [],
    rules: rules.rows.map((item) => item.payload),
    incidents: [],
    events: [],
    audit: [],
    receptionSequence: 0,
  };
  const result = applyToggleRule(state, id, enabled, actor);
  await saveRule(client, result);
  await saveAudit(client, state.audit);
  return result;
};

export type OutboxClaim = { sequence: string; event_id: string };

/** Claim unpublished outbox rows; broker publish must run outside this transaction. */
export const claimOutboxBatch = async (
  client: PoolClient,
): Promise<OutboxClaim[]> => {
  const lock = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended(current_schema()||':outbox',0)) AS acquired",
  );
  if (!lock.rows[0]?.acquired) return [];
  const now = Date.now();
  const { rows } = await client.query<OutboxClaim>(
    `UPDATE event_outbox SET last_error=$1, attempts=attempts+1
     WHERE sequence IN (
       SELECT sequence FROM event_outbox
       WHERE published_at IS NULL
         AND (
           last_error IS NULL
           OR last_error NOT LIKE 'publishing:%'
           OR NULLIF(substring(last_error from 12), '')::bigint < $2
         )
       ORDER BY sequence
       FOR UPDATE SKIP LOCKED
       LIMIT 20
     )
     RETURNING sequence, event_id`,
    [`publishing:${now}`, now - 30_000],
  );
  return rows;
};

export const markOutboxPublished = async (
  client: PoolClient,
  sequence: string,
) => {
  await client.query(
    "UPDATE event_outbox SET published_at=now(), last_error=NULL WHERE sequence=$1",
    [sequence],
  );
};

export const markOutboxFailed = async (
  client: PoolClient,
  sequence: string,
  message: string,
) => {
  await client.query(
    "UPDATE event_outbox SET last_error=$2 WHERE sequence=$1",
    [sequence, redact(message).slice(0, 500)],
  );
};
