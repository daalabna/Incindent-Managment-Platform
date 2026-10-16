import { randomUUID } from "node:crypto";
import type { IncidentPatch } from "../../shared/contracts";
import {
  canTransition,
  healthPolicy,
  type AuditEntry,
  type Incident,
  type IncidentSummary,
  type Rule,
  type Snapshot,
} from "../../shared/domain";
import { assertFinite, refreshServices } from "./apply-health";
import { DomainError } from "./errors";
import { SYSTEM_ACTOR } from "../security/actors";

const withoutTimeline = (incident: IncidentSummary): IncidentSummary => ({
  id: incident.id,
  title: incident.title,
  serviceId: incident.serviceId,
  severity: incident.severity,
  status: incident.status,
  assignee: incident.assignee,
  assigneeEpoch: incident.assigneeEpoch ?? 0,
  alerts: incident.alerts,
  version: incident.version,
  createdAt: incident.createdAt,
  resolvedAt: incident.resolvedAt,
});

/** Public API shape — assigneeEpoch stays internal for runbook undo. */
export const toPublicIncident = <T extends IncidentSummary>(incident: T) => {
  const { assigneeEpoch: _epoch, ...rest } = incident;
  return rest;
};

export const createAudit = (
  text: string,
  actor = SYSTEM_ACTOR,
  incident?: Incident,
): AuditEntry => {
  const entry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    actor,
    text,
    incidentId: incident?.id ?? null,
  };
  if (incident)
    incident.timeline.push({
      id: entry.id,
      at: entry.at,
      actor,
      text,
    });
  return entry;
};

export const record = (
  state: Snapshot,
  text: string,
  actor: string,
  incident?: Incident,
) => {
  state.audit.unshift(createAudit(text, actor, incident));
};

export const renameIncident = (state: Snapshot, from: string, to: string) => {
  const incident = state.incidents.find((item) => item.id === from);
  if (!incident) throw new DomainError("Incident not found", 404);
  incident.id = to;
  for (const entry of state.audit)
    if (entry.incidentId === from) entry.incidentId = to;
};

export const applyUpdate = (
  state: Snapshot,
  id: string,
  version: number,
  patch: IncidentPatch,
  actor: string,
) => {
  const incident = state.incidents.find((item) => item.id === id);
  if (!incident) throw new DomainError("Incident not found", 404);
  if (incident.version !== version)
    throw new DomainError(
      "Incident changed. Latest version loaded; review and retry.",
      409,
    );
  if (patch.status) {
    if (!canTransition(incident.status, patch.status))
      throw new DomainError(
        `Invalid transition: ${incident.status} → ${patch.status}`,
      );
    record(
      state,
      `Status changed: ${incident.status} → ${patch.status}`,
      actor,
      incident,
    );
    incident.status = patch.status;
    if (patch.status === "resolved")
      incident.resolvedAt = new Date().toISOString();
  }
  if (patch.assignee !== undefined) {
    incident.assignee = patch.assignee;
    incident.assigneeEpoch = (incident.assigneeEpoch ?? 0) + 1;
    record(state, `Assigned to ${patch.assignee ?? "nobody"}`, actor, incident);
  }
  if (patch.severity) {
    record(
      state,
      `Severity changed: ${incident.severity} → ${patch.severity}`,
      actor,
      incident,
    );
    incident.severity = patch.severity;
  }
  if (patch.comment) record(state, patch.comment, actor, incident);
  incident.version++;
  return incident;
};

const assertThreshold = (metric: Rule["metric"], threshold: number) => {
  assertFinite(threshold, "threshold");
  const max =
    metric === "latency"
      ? healthPolicy.maxLatencyMs
      : healthPolicy.maxErrorRate;
  if (threshold < 0 || threshold > max)
    throw new DomainError(`${metric} threshold must be between 0 and ${max}`);
};

export const applyAddRule = (
  state: Snapshot,
  rule: Omit<Rule, "id">,
  actor: string,
) => {
  assertThreshold(rule.metric, rule.threshold);
  if (!state.services.some((service) => service.id === rule.serviceId))
    throw new DomainError("Unknown service");
  const next = { ...rule, id: randomUUID() };
  state.rules.push(next);
  record(
    state,
    `Rule created for ${rule.serviceId}: ${rule.metric} > ${rule.threshold}`,
    actor,
  );
  return next;
};

export const applyToggleRule = (
  state: Snapshot,
  id: string,
  enabled: boolean,
  actor: string,
) => {
  const rule = state.rules.find((item) => item.id === id);
  if (!rule) throw new DomainError("Rule not found", 404);
  rule.enabled = enabled;
  record(state, `Rule ${id} ${enabled ? "enabled" : "disabled"}`, actor);
  return rule;
};

const cursorTimestamp =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export type IncidentListStatus = "active" | "resolved" | "all";

export const incidentCursor = (cursor?: string) => {
  if (!cursor) return null;
  const separator = cursor.indexOf("|");
  const createdAt = separator > 0 ? cursor.slice(0, separator) : "";
  const id = separator > 0 ? cursor.slice(separator + 1) : "";
  const match = cursorTimestamp.exec(createdAt);
  const parsed = new Date(createdAt);
  if (!match || !id || Number.isNaN(parsed.getTime()))
    throw new DomainError("Invalid cursor", 400);
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const sameClock =
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day) &&
    parsed.getUTCHours() === Number(hour) &&
    parsed.getUTCMinutes() === Number(minute) &&
    parsed.getUTCSeconds() === Number(second) &&
    parsed.getUTCMilliseconds() === Number(fraction.padEnd(3, "0"));
  if (!sameClock) throw new DomainError("Invalid cursor", 400);
  return { createdAt, id };
};

export const toSummary = (
  state: Omit<Snapshot, "incidents"> & { incidents: IncidentSummary[] },
  auditLimit = 20,
) => {
  refreshServices(state);
  return {
    services: state.services,
    incidents: state.incidents
      .filter((incident) => incident.status !== "resolved")
      .map(withoutTimeline)
      .map(toPublicIncident),
    resolvedCount: state.incidents.filter(
      (incident) => incident.status === "resolved",
    ).length,
    rules: state.rules,
    audit: state.audit.slice(0, auditLimit),
    eventCount: Math.max(state.receptionSequence ?? 0, state.events.length),
  };
};

export const listIncidents = (
  state: Snapshot,
  limit: number,
  cursor?: string,
  status: IncidentListStatus = "all",
  q = "",
) => {
  incidentCursor(cursor);
  const needle = q.trim().toLowerCase();
  const items = state.incidents
    .filter((incident) => {
      const statusMatches =
        status === "all" ||
        (status === "active"
          ? incident.status !== "resolved"
          : incident.status === "resolved");
      const text =
        `${incident.id} ${incident.title} ${incident.assignee ?? ""}`.toLowerCase();
      return statusMatches && (!needle || text.includes(needle));
    })
    .map(withoutTimeline);
  const found = cursor
    ? items.findIndex((item) => `${item.createdAt}|${item.id}` === cursor)
    : 0;
  if (cursor && found < 0) return { items: [], nextCursor: null };
  const start = cursor ? found + 1 : 0;
  const page = items.slice(start, start + limit).map(toPublicIncident);
  const last = page.length === limit ? page[page.length - 1] : undefined;
  const nextCursor =
    last && start + limit < items.length
      ? `${last.createdAt}|${last.id}`
      : null;
  return { items: page, nextCursor };
};
