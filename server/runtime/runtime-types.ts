import type {
  EventReceipt,
  HealthResponse,
  IncidentPatch,
} from "../../shared/contracts";
import type {
  Incident,
  MonitoringEvent,
  Rule,
  Snapshot,
  Summary,
} from "../../shared/domain";
import type { IncidentListStatus } from "../domain/apply";
import type { ChangeNotice } from "../broker/redis";

export type IngestResult =
  | { duplicate: true }
  | {
      duplicate: false;
      incidentId: string | null;
      created: boolean;
      stale: boolean;
    };

export interface Runtime {
  mode: "local" | "distributed";
  snapshot(): Promise<Snapshot>;
  summary(): Promise<Summary>;
  incident(id: string): Promise<Incident>;
  incidents(
    limit: number,
    cursor?: string,
    status?: IncidentListStatus,
    q?: string,
  ): Promise<{
    items: Summary["incidents"];
    nextCursor: string | null;
  }>;
  activity(
    limit: number,
    offset?: number,
  ): Promise<{ items: Snapshot["audit"]; nextOffset: number | null }>;
  ingest(event: MonitoringEvent): Promise<IngestResult | EventReceipt>;
  update(
    id: string,
    version: number,
    patch: IncidentPatch,
    actor?: string,
  ): Promise<Incident>;
  addRule(rule: Omit<Rule, "id">, actor?: string): Promise<Rule>;
  toggleRule(id: string, enabled: boolean, actor?: string): Promise<Rule>;
  record(text: string, actor: string): Promise<void>;
  acquireSimulation(): Promise<string | null>;
  renewSimulation(token: string): Promise<boolean>;
  releaseSimulation(token: string): Promise<void>;
  health(): Promise<HealthResponse>;
  eventStatus(id: string): Promise<EventReceipt>;
  close(): Promise<void>;
}

export const changed = (incidentId: string | null = null): ChangeNotice => ({
  scopes: incidentId
    ? ["summary", "activity", "incident"]
    : ["summary", "activity"],
  incidentId,
});
