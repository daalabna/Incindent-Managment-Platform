import type { MonitoringEvent, Service, Snapshot } from "../../shared/domain";
import { evidenceBasis, type RuleEvidence } from "./windows";
import {
  aggregateHealth,
  assertFinite,
  normalizeService,
} from "./apply-health";
import { record } from "./apply-changes";
import { DomainError } from "./errors";
import { NOTIFICATION_ADAPTER, RULES_ENGINE } from "../security/actors";

export type IngestResult = {
  duplicate: false;
  incidentId: string | null;
  created: boolean;
  stale: boolean;
};

export const nextSequence = (state: Snapshot) => {
  state.receptionSequence = (state.receptionSequence ?? 0) + 1;
  return state.receptionSequence;
};

const correlate = (
  state: Snapshot,
  service: Service,
  event: MonitoringEvent,
  temporaryIds: boolean,
  matchedRuleIds?: string[],
  related?: string[],
  basis?: string,
): IngestResult => {
  const matching = state.rules.filter(
    (rule) =>
      rule.enabled &&
      rule.serviceId === event.source &&
      rule.metric === event.type &&
      (matchedRuleIds
        ? matchedRuleIds.includes(rule.id)
        : event.value > rule.threshold),
  );
  if (!matching.length)
    return { duplicate: false, incidentId: null, created: false, stale: false };
  const severity = matching.map((rule) => rule.severity).sort()[0];
  if (!severity) throw new DomainError("Matching rule has no severity");
  const incident = state.incidents.find(
    (item) =>
      item.status !== "resolved" &&
      (item.serviceId === event.source ||
        (related?.includes(item.serviceId) &&
          Date.now() - Date.parse(item.createdAt) <= 300_000)),
  );
  if (incident) {
    incident.alerts++;
    incident.version++;
    if (severity < incident.severity) incident.severity = severity;
    record(
      state,
      `Alert correlated: ${basis ?? `${event.type} = ${event.value}`}`,
      RULES_ENGINE,
      incident,
    );
    return {
      duplicate: false,
      incidentId: incident.id,
      created: false,
      stale: false,
    };
  }
  const created = {
    id: temporaryIds
      ? `pending:${event.id}`
      : `INC-${1001 + state.incidents.length}`,
    title: `${service.name} service degradation`,
    serviceId: service.id,
    severity,
    status: "triggered" as const,
    assignee: null,
    assigneeEpoch: 0,
    alerts: 1,
    version: 1,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    timeline: [],
  };
  state.incidents.unshift(created);
  record(
    state,
    `Incident created: ${basis ?? `${event.type} = ${event.value}`}`,
    RULES_ENGINE,
    created,
  );
  record(
    state,
    "Local notification delivered to activity log",
    NOTIFICATION_ADAPTER,
    created,
  );
  return {
    duplicate: false,
    incidentId: created.id,
    created: true,
    stale: false,
  };
};

export const applyWindowMatch = (
  state: Snapshot,
  source: string,
  evidence: RuleEvidence[],
  related: string[],
): IngestResult => {
  const first = evidence[0];
  if (!first)
    return { duplicate: false, incidentId: null, created: false, stale: false };
  const service = state.services.find((item) => item.id === source);
  if (!service) throw new DomainError("Unknown event source", 404);
  return correlate(
    state,
    normalizeService(service),
    {
      id: `window:${source}:${first.metric}`,
      source,
      type: first.metric,
      value: first.value,
      timestamp: new Date().toISOString(),
    },
    true,
    evidence.map((item) => item.ruleId),
    related,
    evidenceBasis(evidence),
  );
};

export const applyIngest = (
  state: Snapshot,
  event: MonitoringEvent,
  sequence: number,
  now = Date.now(),
  options?: {
    temporaryIds?: boolean;
    matchedRuleIds?: string[];
    related?: string[];
    eventTime?: boolean;
    late?: boolean;
  },
): IngestResult => {
  assertFinite(event.value, event.type);
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new DomainError("Invalid event sequence");
  const service = state.services.find((item) => item.id === event.source);
  if (!service) throw new DomainError("Unknown event source", 404);
  const normalized = normalizeService(service);
  const index = state.services.indexOf(service);
  state.services[index] = normalized;
  state.events.unshift(event);
  state.events = state.events.slice(0, 200);
  if (options?.late) {
    record(
      state,
      `Late event ${event.id} retained behind watermark`,
      RULES_ENGINE,
    );
    return { duplicate: false, incidentId: null, created: false, stale: true };
  }
  const previous = normalized.observations[event.type];
  const eventAt = Date.parse(event.timestamp);
  const previousAt = previous ? Date.parse(previous.at) : Number.NaN;
  const stale = options?.eventTime
    ? Boolean(previous) &&
      (eventAt < previousAt ||
        (eventAt === previousAt && sequence <= previous!.sequence))
    : Boolean(previous) && sequence <= previous!.sequence;
  if (stale && previous) {
    normalized.health = aggregateHealth(normalized, now);
    const open = state.incidents.some(
      (item) => item.serviceId === event.source && item.status !== "resolved",
    );
    if (
      !open ||
      normalized.health === "healthy" ||
      normalized.health === "unknown" ||
      event.type === "health"
    ) {
      record(
        state,
        `Ignored stale ${event.type} observation ${event.value}; a newer value is already applied`,
        RULES_ENGINE,
      );
      return {
        duplicate: false,
        incidentId: null,
        created: false,
        stale: true,
      };
    }
    const retained = correlate(
      state,
      normalized,
      event,
      options?.temporaryIds ?? false,
      options?.matchedRuleIds,
      options?.related,
    );
    return { ...retained, stale: true };
  }
  normalized.observations[event.type] = {
    value: event.value,
    sequence,
    at: options?.eventTime ? event.timestamp : new Date(now).toISOString(),
  };
  if (event.type === "latency") {
    normalized.latency = event.value;
    normalized.history = [...normalized.history.slice(-23), event.value];
  }
  if (event.type === "error_rate") normalized.errorRate = event.value;
  normalized.health = aggregateHealth(normalized, now);
  if (event.type === "health")
    return { duplicate: false, incidentId: null, created: false, stale: false };
  return correlate(
    state,
    normalized,
    event,
    options?.temporaryIds ?? false,
    options?.matchedRuleIds,
    options?.related,
  );
};

export {
  aggregateHealth,
  normalizeService,
  refreshServices,
} from "./apply-health";
export {
  applyAddRule,
  applyToggleRule,
  applyUpdate,
  createAudit,
  listIncidents,
  renameIncident,
  toPublicIncident,
  toSummary,
  type IncidentListStatus,
} from "./apply-changes";
