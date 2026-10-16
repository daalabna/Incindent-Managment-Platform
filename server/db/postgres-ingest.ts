import type { PoolClient } from "pg";
import type {
  Incident,
  MonitoringEvent,
  Rule,
  Service,
  Snapshot,
} from "../../shared/domain";
import {
  applyIngest,
  applyWindowMatch,
  normalizeService,
  renameIncident,
  type IngestResult,
} from "../domain/apply";
import { DomainError } from "../domain/errors";
import type { EventProcessRow } from "./postgres-read";
import { evaluateEventTime, relatedServices } from "./event-time";
import { saveRuleMatches } from "./rule-matches";
import { enqueueNotification } from "../operations/notifications";
import { advisoryLockSql } from "./locks";
import { saveAudit, saveIncident } from "./postgres-write";

export const loadServiceContext = async (
  client: PoolClient,
  source: string,
) => {
  const services = await client.query<{ payload: Service }>(
    "SELECT payload FROM services WHERE id=$1 FOR UPDATE",
    [source],
  );
  const rules = await client.query<{ payload: Rule }>(
    "SELECT payload FROM rules WHERE service_id=$1",
    [source],
  );
  const related = await relatedServices(client, source);
  return {
    services: services.rows.map((item) => normalizeService(item.payload)),
    rules: rules.rows.map((item) => item.payload),
    related,
  };
};

export const lockOpenIncidents = async (
  client: PoolClient,
  related: string[],
) => {
  const incidents = await client.query<{ payload: Incident }>(
    "SELECT payload FROM incidents WHERE service_id=ANY($1::text[]) AND status <> 'resolved' ORDER BY created_at DESC FOR UPDATE",
    [related],
  );
  return incidents.rows.map((item) => ({ ...item.payload, timeline: [] }));
};

export const correlationState = (
  services: Service[],
  rules: Rule[],
  incidents: Incident[],
): Snapshot => ({
  services,
  rules,
  incidents,
  audit: [],
  events: [],
  receptionSequence: 0,
});

export const commitIngest = async (
  client: PoolClient,
  state: Snapshot,
  result: IngestResult,
) => {
  if (result.created && result.incidentId) {
    const allocated = await client.query<{ number: string }>(
      "SELECT nextval('incident_number') AS number",
    );
    const number = allocated.rows[0]?.number;
    if (!number) throw new DomainError("Could not allocate incident id", 500);
    const nextId = `INC-${number}`;
    renameIncident(state, result.incidentId, nextId);
    result.incidentId = nextId;
  }
  if (result.incidentId) {
    const incident = state.incidents.find(
      (item) => item.id === result.incidentId,
    );
    if (incident) await saveIncident(client, incident);
  }
  await saveAudit(client, state.audit);
  if (result.created && result.incidentId)
    await enqueueNotification(client, result.incidentId, "Incident created");
  return result;
};

export const applyQueuedEvent = async (client: PoolClient, id: string) => {
  await client.query(advisoryLockSql("events"));
  const { rows } = await client.query<EventProcessRow>(
    "SELECT sequence, payload, processed_at, incident_id, failure FROM monitoring_events WHERE id=$1 FOR UPDATE",
    [id],
  );
  const row = rows[0];
  if (!row) throw new DomainError("Queued event does not exist", 404);
  if (row.processed_at || row.failure) return { duplicate: true as const };
  if (!row.payload) throw new DomainError("Queued event has no payload");
  const sequence = Number(row.sequence);
  const event = row.payload as MonitoringEvent;
  const context = await loadServiceContext(client, event.source);
  const evaluated = await evaluateEventTime(client, event, context.rules);
  const points = evaluated.matches.filter(
    (match) => match.aggregation === "point",
  );
  const windows = evaluated.matches.filter(
    (match) => match.aggregation !== "point",
  );
  const state = correlationState(
    context.services,
    context.rules,
    await lockOpenIncidents(client, context.related),
  );
  const pointResult = applyIngest(state, event, sequence, Date.now(), {
    temporaryIds: true,
    matchedRuleIds: points.map((match) => match.ruleId),
    related: context.related,
    eventTime: true,
    late: evaluated.late,
  });
  const windowResult = windows.length
    ? applyWindowMatch(state, event.source, windows, context.related)
    : pointResult;
  for (const service of state.services)
    await client.query("UPDATE services SET payload=$2 WHERE id=$1", [
      service.id,
      service,
    ]);
  const result = await commitIngest(
    client,
    state,
    pointResult.created ? pointResult : windowResult,
  );
  if (result.incidentId && windows.length)
    await saveRuleMatches(client, event.source, result.incidentId, windows);
  await client.query(
    "UPDATE monitoring_events SET processed_at=now(), incident_id=$2, failure=NULL WHERE id=$1",
    [id, points.length ? result.incidentId : null],
  );
  return result;
};
