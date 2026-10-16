export const severities = ["P1", "P2", "P3"] as const;
export const statuses = [
  "triggered",
  "acknowledged",
  "investigating",
  "mitigated",
  "resolved",
] as const;
export const eventTypes = ["error_rate", "latency", "health"] as const;
export const ruleMetrics = ["error_rate", "latency"] as const;
export const healthStates = [
  "healthy",
  "degraded",
  "outage",
  "unknown",
] as const;

export const healthPolicy = {
  latencyDegradedAbove: 1200,
  errorRateDegradedAbove: 5,
  freshForMs: 5 * 60 * 1000,
  maxErrorRate: 100,
  maxLatencyMs: 120_000,
  stuckOutboxMs: 30_000,
} as const;

export const transitions = {
  triggered: ["acknowledged"],
  acknowledged: ["investigating"],
  investigating: ["mitigated", "resolved"],
  mitigated: ["resolved"],
  resolved: [],
} as const satisfies Record<(typeof statuses)[number], readonly Status[]>;

export type Status = (typeof statuses)[number];
export type Severity = (typeof severities)[number];
export type Health = (typeof healthStates)[number];
export type EventType = (typeof eventTypes)[number];
export type RuleMetric = (typeof ruleMetrics)[number];

export type Observation = {
  value: number;
  sequence: number;
  at: string;
};

export type Service = {
  id: string;
  name: string;
  description: string;
  health: Health;
  latency: number;
  errorRate: number;
  history: number[];
  observations: Partial<Record<EventType, Observation>>;
};

export type TimelineEntry = {
  id: string;
  at: string;
  actor: string;
  text: string;
};

export type Incident = {
  id: string;
  title: string;
  serviceId: string;
  severity: Severity;
  status: Status;
  assignee: string | null;
  /** Bumps on every assignee write so runbook undo can detect intervening edits (incl. A→B→A). */
  assigneeEpoch: number;
  alerts: number;
  version: number;
  createdAt: string;
  resolvedAt: string | null;
  timeline: TimelineEntry[];
};

export type IncidentSummary = Omit<Incident, "timeline">;
/** API-facing incident — assigneeEpoch stays on the storage model only. */
export type PublicIncident = Omit<Incident, "assigneeEpoch">;
export type PublicIncidentSummary = Omit<IncidentSummary, "assigneeEpoch">;

export type Rule = {
  id: string;
  serviceId: string;
  metric: RuleMetric;
  threshold: number;
  severity: Severity;
  enabled: boolean;
  windowSeconds?: number;
  allowedLatenessSeconds?: number;
  minSamples?: number;
  aggregation?: "avg" | "max" | "all";
};

export type MonitoringEvent = {
  id: string;
  source: string;
  type: EventType;
  value: number;
  timestamp: string;
};

export type AuditEntry = TimelineEntry & { incidentId: string | null };

export type Snapshot = {
  services: Service[];
  incidents: Incident[];
  rules: Rule[];
  audit: AuditEntry[];
  events: MonitoringEvent[];
  receptionSequence: number;
};

export type Summary = {
  services: Service[];
  incidents: PublicIncidentSummary[];
  resolvedCount: number;
  rules: Rule[];
  audit: AuditEntry[];
  eventCount: number;
};

export const canTransition = (from: Status, to: Status) =>
  (transitions[from] as readonly string[]).includes(to);
