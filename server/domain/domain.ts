import {
  applyAddRule,
  applyIngest,
  applyToggleRule,
  applyUpdate,
  createAudit,
  nextSequence,
  normalizeService,
} from "./apply";
import type { IncidentPatch } from "../../shared/contracts";
import type {
  Incident,
  MonitoringEvent,
  Rule,
  Snapshot,
} from "../../shared/domain";
import { LOCAL_OPERATOR, SYSTEM_ACTOR } from "../security/actors";

export { DomainError } from "./errors";

export class DomainState {
  state: Snapshot;
  constructor(state?: Snapshot) {
    this.state = state ?? this.seed();
    this.state.receptionSequence ??= 0;
    this.state.services = this.state.services.map(normalizeService);
  }
  seed = (): Snapshot => {
    const names = [
      ["api-gateway", "API Gateway", "Public API & routing", 42],
      ["payments", "Payments", "Transactions & billing", 86],
      ["users", "Users", "Identity & profiles", 28],
      ["search-api", "Search", "Search & discovery", 112],
      ["notifications", "Notifications", "Email & messaging", 65],
      ["redis", "Redis", "Cache & session storage", 4],
    ] as const;
    return {
      services: names.map(([id, name, description, latency]) => ({
        id,
        name,
        description,
        health: "healthy" as const,
        latency,
        errorRate: 0,
        history: Array.from({ length: 24 }, (_, i) =>
          Math.round(latency * (0.75 + Math.sin(i * 1.7) * 0.16)),
        ),
        observations: {},
      })),
      incidents: [],
      audit: [],
      events: [],
      rules: [
        {
          id: "rule-search-errors",
          serviceId: "search-api",
          metric: "error_rate",
          threshold: 5,
          severity: "P1",
          enabled: true,
        },
        {
          id: "rule-search-latency",
          serviceId: "search-api",
          metric: "latency",
          threshold: 1200,
          severity: "P2",
          enabled: true,
        },
        {
          id: "rule-payment-errors",
          serviceId: "payments",
          metric: "error_rate",
          threshold: 3,
          severity: "P1",
          enabled: true,
        },
      ],
      receptionSequence: 0,
    };
  };
  transaction = <T>(fn: () => T): T => fn();
  protected hasEvent = (_id: string): boolean => false;
  protected rememberEvent = (_id: string): void => {};
  protected claimEvent = (event: MonitoringEvent): "new" | "duplicate" => {
    if (this.hasEvent(event.id)) return "duplicate";
    this.rememberEvent(event.id);
    return "new";
  };
  record = (text: string, actor = SYSTEM_ACTOR, incident?: Incident) => {
    this.state.audit.unshift(createAudit(text, actor, incident));
  };
  ingest = (event: MonitoringEvent, sequence?: number) => {
    return this.transaction(() => {
      if (this.claimEvent(event) === "duplicate")
        return { duplicate: true as const };
      const allocated = sequence ?? nextSequence(this.state);
      if (sequence !== undefined)
        this.state.receptionSequence = Math.max(
          this.state.receptionSequence ?? 0,
          sequence,
        );
      return applyIngest(this.state, event, allocated);
    });
  };
  update = (
    id: string,
    version: number,
    patch: IncidentPatch,
    actor = LOCAL_OPERATOR,
  ) =>
    this.transaction(() => applyUpdate(this.state, id, version, patch, actor));
  addRule = (rule: Omit<Rule, "id">, actor = LOCAL_OPERATOR) =>
    this.transaction(() => applyAddRule(this.state, rule, actor));
  toggleRule = (id: string, enabled: boolean, actor = LOCAL_OPERATOR) =>
    this.transaction(() => applyToggleRule(this.state, id, enabled, actor));
}
