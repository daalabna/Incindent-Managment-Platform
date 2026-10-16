import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  Incident,
  MonitoringEvent,
  Rule,
  Service,
} from "../../shared/domain";
import { DomainError } from "../domain/errors";
import { readTimelineEntries } from "../db/incident-timeline";
import { limitationText, takeSources, type Candidate } from "./context-budget";

export type AnalysisContext = {
  incidentId: string;
  incidentVersion: number;
  sources: import("../../shared/ai").Evidence[];
  limitations: string[];
};

export { redactEvidence, takeSources } from "./context-budget";

export const contextHash = (value: AnalysisContext) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const citeLimitations = (context: AnalysisContext): AnalysisContext =>
  context.sources.some((source) => source.id === "limitations")
    ? context
    : {
        ...context,
        sources: [
          ...context.sources,
          {
            id: "limitations",
            kind: "limitation",
            label: "ограничения контекста",
            text: context.limitations.join("\n"),
          },
        ],
      };

export const collectContext = async (
  client: PoolClient,
  id: string,
): Promise<AnalysisContext> => {
  const row = (
    await client.query<{ payload: Incident }>(
      "SELECT payload - 'timeline' AS payload FROM incidents WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!row) throw new DomainError("Incident not found", 404);
  const timeline = await readTimelineEntries(client, id, 25);
  const incident = { ...row.payload, timeline };
  const from = new Date(
    Date.parse(incident.createdAt) - 15 * 60_000,
  ).toISOString();
  const until = new Date(
    Date.parse(incident.resolvedAt ?? new Date().toISOString()) + 15 * 60_000,
  ).toISOString();
  const events = await client.query<{
    incident_id: string | null;
    payload: MonitoringEvent;
  }>(
    `SELECT incident_id,payload FROM monitoring_events WHERE payload IS NOT NULL AND (
      incident_id=$1 OR (service_id=$2 AND incident_id IS NULL AND received_at>=$3::timestamptz AND received_at<=$4::timestamptz)
    ) ORDER BY sequence DESC LIMIT 30`,
    [id, incident.serviceId, from, until],
  );
  const service = (
    await client.query<{ payload: Service }>(
      "SELECT payload FROM services WHERE id=$1",
      [incident.serviceId],
    )
  ).rows[0]?.payload;
  const rules = await client.query<{ payload: Rule }>(
    "SELECT payload FROM rules WHERE service_id=$1 ORDER BY id LIMIT 15",
    [incident.serviceId],
  );
  const edges = await client.query<{ service_id: string; depends_on: string }>(
    "SELECT service_id,depends_on FROM service_dependencies WHERE service_id=$1 OR depends_on=$1 ORDER BY service_id,depends_on LIMIT 20",
    [incident.serviceId],
  );
  const windows = await client.query<{
    service_id: string;
    rule_id: string;
    metric: string;
    aggregation: string;
    threshold: number;
    value: number;
    samples: number;
    window_start: Date | null;
    window_end: Date | null;
    event_ids: string[];
  }>(
    "SELECT service_id,rule_id,metric,aggregation,threshold,value,samples,window_start,window_end,event_ids FROM rule_matches WHERE incident_id=$1 ORDER BY window_start DESC NULLS LAST LIMIT 8",
    [id],
  );
  const candidates: Candidate[] = [
    {
      kind: "incident",
      label: incident.id,
      text: JSON.stringify({
        title: incident.title,
        serviceId: incident.serviceId,
        severity: incident.severity,
        status: incident.status,
        createdAt: incident.createdAt,
        resolvedAt: incident.resolvedAt,
        alerts: incident.alerts,
      }),
    },
    ...events.rows.map((row) => ({
      kind: "event" as const,
      label: `${row.incident_id ? "событие инцидента" : "наблюдение сервиса"} · ${row.payload.source} · ${row.payload.timestamp}`,
      text: JSON.stringify({
        source: row.payload.source,
        type: row.payload.type,
        value: row.payload.value,
        timestamp: row.payload.timestamp,
      }),
    })),
    ...[...incident.timeline].reverse().map((entry) => ({
      kind: "timeline" as const,
      label: entry.at,
      text: `${entry.actor}: ${entry.text}`,
    })),
    ...windows.rows.map((row) => ({
      kind: "rule" as const,
      label: `срабатывание окна ${row.metric}`,
      text: JSON.stringify({
        serviceId: row.service_id,
        ruleId: row.rule_id,
        metric: row.metric,
        aggregation: row.aggregation,
        threshold: Number(row.threshold),
        value: Number(row.value),
        samples: row.samples,
        windowStart: row.window_start,
        windowEnd: row.window_end,
        eventIds: row.event_ids,
      }),
    })),
  ];
  if (service)
    candidates.push({
      kind: "service",
      label: service.name,
      text: JSON.stringify({ observations: service.observations }),
    });
  rules.rows.forEach((row) =>
    candidates.push({
      kind: "rule",
      label: "Текущее правило (может отличаться от правила при событии)",
      text: JSON.stringify(row.payload),
    }),
  );
  edges.rows.forEach((row) =>
    candidates.push({
      kind: "dependency",
      label: `${row.service_id} → ${row.depends_on}`,
      text: JSON.stringify(row),
    }),
  );
  const fitted = takeSources(candidates);
  const limitations = limitationText(fitted.omitted, fitted.truncated);
  if (!events.rowCount)
    limitations.push(
      "Связанные события отсутствуют или их payload удалён политикой хранения.",
    );
  limitations.push(
    "Наблюдения сервиса без incident_id взяты только в окне ±15 минут вокруг инцидента. Это не полная причинная картина.",
  );
  return citeLimitations({
    incidentId: id,
    incidentVersion: incident.version,
    sources: fitted.sources,
    limitations,
  });
};
