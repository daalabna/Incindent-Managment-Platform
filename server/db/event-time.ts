import type { PoolClient } from "pg";
import type { MonitoringEvent, Rule } from "../../shared/domain";
import {
  matchesAggregate,
  windowStart,
  type RuleEvidence,
} from "../domain/windows";
import { DomainError } from "../domain/errors";
import { advisoryLockSql } from "./locks";

// Persisted per-stream event-time watermark. Late data is retained, never changes a finalized window.
export const evaluateEventTime = async (
  client: PoolClient,
  event: MonitoringEvent,
  rules: Rule[],
) => {
  const at = Date.parse(event.timestamp);
  if (!Number.isFinite(at) || at > Date.now() + 60_000)
    throw new DomainError("Invalid/future event timestamp");
  const lateness =
    rules
      .filter((rule) => rule.enabled && rule.metric === event.type)
      .reduce(
        (max, rule) => Math.max(max, rule.allowedLatenessSeconds ?? 30),
        0,
      ) * 1000;
  const previous = await client.query<{ watermark: Date }>(
    "SELECT watermark FROM stream_watermarks WHERE service_id=$1 AND metric=$2 FOR UPDATE",
    [event.source, event.type],
  );
  const late =
    previous.rows[0] !== undefined && at < previous.rows[0].watermark.getTime();
  if (late) return { late: true, matches: [] as RuleEvidence[] };
  await client.query(
    "INSERT INTO metric_samples(event_id,service_id,metric,value,event_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [event.id, event.source, event.type, event.value, event.timestamp],
  );
  const water = await client.query<{ watermark: Date }>(
    `INSERT INTO stream_watermarks(service_id,metric,max_event_at,watermark) VALUES($1,$2,$3,$4)
    ON CONFLICT(service_id,metric) DO UPDATE SET max_event_at=GREATEST(stream_watermarks.max_event_at,EXCLUDED.max_event_at),watermark=GREATEST(stream_watermarks.watermark,EXCLUDED.watermark) RETURNING watermark`,
    [event.source, event.type, event.timestamp, new Date(at - lateness)],
  );
  const watermark = water.rows[0]!.watermark.getTime();
  const matches: RuleEvidence[] = [];
  for (const rule of rules.filter(
    (rule) => rule.enabled && rule.metric === event.type,
  )) {
    if (!rule.windowSeconds) {
      if (event.value > rule.threshold)
        matches.push({
          ruleId: rule.id,
          serviceId: event.source,
          metric: rule.metric,
          aggregation: "point",
          threshold: rule.threshold,
          value: event.value,
          samples: 1,
          windowStart: null,
          windowEnd: null,
          eventIds: [event.id],
        });
      continue;
    }
    matches.push(
      ...(await finalizeWindow(client, rule, event.source, watermark)).evidence,
    );
  }
  return { late: false, matches };
};

export const finalizeWindow = async (
  client: PoolClient,
  rule: Rule,
  serviceId: string,
  watermarkMs: number,
) => {
  const windowSeconds = rule.windowSeconds;
  if (!windowSeconds) return { evidence: [] as RuleEvidence[] };
  const endMs = windowStart(watermarkMs, windowSeconds);
  const evaluated = await client.query<{ finalized_at: Date | null }>(
    "SELECT finalized_at FROM rule_evaluations WHERE rule_id=$1",
    [rule.id],
  );
  const finalized = evaluated.rows[0]?.finalized_at;
  if (finalized && finalized.getTime() >= endMs)
    return { evidence: [] as RuleEvidence[] };
  const since = finalized ?? new Date(endMs - windowSeconds * 1000);
  const samples = await client.query<{
    samples: number;
    maximum: number;
    minimum: number;
    average: number;
    sustained: boolean;
    window_ms: string;
    event_ids: string[];
  }>(
    `WITH grouped AS (
       SELECT floor(extract(epoch FROM event_at)/$5) AS bucket, count(*)::int AS samples,
         max(value) AS maximum, min(value) AS minimum, avg(value) AS average, bool_and(value > $6) AS sustained
       FROM metric_samples WHERE service_id=$1 AND metric=$2 AND event_at >= $3 AND event_at < $4
       GROUP BY 1
     )
     SELECT g.samples, g.maximum, g.minimum, g.average, g.sustained, (g.bucket*$5*1000)::bigint AS window_ms,
       COALESCE(ids.event_ids, '{}') AS event_ids
     FROM grouped g
     LEFT JOIN LATERAL (
       SELECT array_agg(picked.event_id ORDER BY picked.event_at) AS event_ids
       FROM (
         SELECT event_id, event_at FROM metric_samples
         WHERE service_id=$1 AND metric=$2 AND event_at >= $3 AND event_at < $4
           AND floor(extract(epoch FROM event_at)/$5)=g.bucket
         ORDER BY event_at LIMIT 20
       ) picked
     ) ids ON true`,
    [
      serviceId,
      rule.metric,
      since,
      new Date(endMs),
      windowSeconds,
      rule.threshold,
    ],
  );
  const aggregation = rule.aggregation ?? "avg";
  const evidence = samples.rows.flatMap((sample) => {
    const aggregate = {
      samples: sample.samples,
      maximum: Number(sample.maximum),
      average: Number(sample.average),
      sustained: sample.sustained,
    };
    if (!matchesAggregate(aggregate, rule)) return [];
    const start = Number(sample.window_ms);
    const value =
      aggregation === "max"
        ? aggregate.maximum
        : aggregation === "all"
          ? Number(sample.minimum)
          : aggregate.average;
    return [
      {
        ruleId: rule.id,
        serviceId,
        metric: rule.metric,
        aggregation,
        threshold: rule.threshold,
        value,
        samples: sample.samples,
        windowStart: new Date(start).toISOString(),
        windowEnd: new Date(start + windowSeconds * 1000).toISOString(),
        eventIds: sample.event_ids.slice(0, 20),
      } satisfies RuleEvidence,
    ];
  });
  await client.query(
    `INSERT INTO rule_evaluations(rule_id,finalized_at) VALUES($1,$2)
    ON CONFLICT(rule_id) DO UPDATE SET finalized_at=GREATEST(COALESCE(rule_evaluations.finalized_at, EXCLUDED.finalized_at), EXCLUDED.finalized_at)`,
    [rule.id, new Date(endMs)],
  );
  return { evidence };
};

export const relatedServices = async (client: PoolClient, source: string) => {
  const { rows } = await client.query<{ id: string }>(
    `WITH RECURSIVE
    upstream(id) AS (
      SELECT depends_on FROM service_dependencies WHERE service_id=$1
      UNION SELECT d.depends_on FROM upstream JOIN service_dependencies d ON d.service_id=upstream.id
    ),
    downstream(id) AS (
      SELECT service_id FROM service_dependencies WHERE depends_on=$1
      UNION SELECT d.service_id FROM downstream JOIN service_dependencies d ON d.depends_on=downstream.id
    )
    SELECT $1::text AS id UNION SELECT id FROM upstream UNION SELECT id FROM downstream`,
    [source],
  );
  return rows.map((row) => row.id);
};

export const addDependency = async (
  client: PoolClient,
  service: string,
  dependency: string,
) => {
  await client.query(advisoryLockSql("dependencies"));
  const cycle = await client.query(
    `WITH RECURSIVE graph(id) AS (SELECT $1::text UNION SELECT d.depends_on FROM graph JOIN service_dependencies d ON d.service_id=graph.id) SELECT id FROM graph WHERE id=$2`,
    [dependency, service],
  );
  if (cycle.rowCount) throw new DomainError("Dependency graph must be acyclic");
  const exists = await client.query(
    "SELECT id FROM services WHERE id=ANY($1::text[])",
    [[service, dependency]],
  );
  if (exists.rowCount !== 2) throw new DomainError("Unknown service");
  await client.query(
    "INSERT INTO service_dependencies(service_id,depends_on) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [service, dependency],
  );
};
