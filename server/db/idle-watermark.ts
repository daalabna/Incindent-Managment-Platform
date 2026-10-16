import type { PoolClient } from "pg";
import type { Rule } from "../../shared/domain";
import type { RuleEvidence } from "../domain/windows";
import { advisoryLockSql } from "./locks";
import { finalizeWindow } from "./event-time";
import { openWindowIncident } from "./window-incident";

export const nextIdleWatermark = (
  maxEventAt: number,
  watermark: number,
  now: number,
  latenessMs: number,
) => {
  const idleAt = now - latenessMs;
  if (maxEventAt > idleAt || watermark >= idleAt) return watermark;
  return idleAt;
};

export const closeIdleStreams = async (
  client: PoolClient,
  now = Date.now(),
) => {
  const streams = await client.query<{
    service_id: string;
    metric: string;
    max_event_at: Date;
    watermark: Date;
  }>(
    "SELECT service_id, metric, max_event_at, watermark FROM stream_watermarks FOR UPDATE",
  );
  if (!streams.rowCount) return;
  const rules = (
    await client.query<{ payload: Rule }>("SELECT payload FROM rules")
  ).rows.map((row) => row.payload);
  for (const stream of streams.rows) {
    const matching = rules.filter(
      (rule) =>
        rule.enabled &&
        rule.serviceId === stream.service_id &&
        rule.metric === stream.metric,
    );
    const latenessMs =
      (matching.length
        ? matching.reduce(
            (max, rule) => Math.max(max, rule.allowedLatenessSeconds ?? 30),
            0,
          )
        : 30) * 1000;
    const next = nextIdleWatermark(
      stream.max_event_at.getTime(),
      stream.watermark.getTime(),
      now,
      latenessMs,
    );
    if (next === stream.watermark.getTime()) continue;
    await client.query(
      "UPDATE stream_watermarks SET watermark=$3 WHERE service_id=$1 AND metric=$2",
      [stream.service_id, stream.metric, new Date(next)],
    );
    const evidence: RuleEvidence[] = [];
    for (const rule of matching) {
      if (!rule.windowSeconds) continue;
      evidence.push(
        ...(await finalizeWindow(client, rule, stream.service_id, next))
          .evidence,
      );
    }
    if (evidence.length)
      await openWindowIncident(client, stream.service_id, evidence);
  }
};

export const idleTick = (store: {
  transaction: <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;
}) =>
  store.transaction(async (client) => {
    await client.query(advisoryLockSql("events"));
    await closeIdleStreams(client);
  });
