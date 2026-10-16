import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { RuleEvidence } from "../domain/windows";

export const saveRuleMatches = async (
  client: PoolClient,
  serviceId: string,
  incidentId: string,
  evidence: RuleEvidence[],
) => {
  const windows = evidence.filter((item) => item.windowStart);
  for (const item of windows) {
    await client.query(
      `INSERT INTO rule_matches(id,incident_id,rule_id,service_id,metric,aggregation,threshold,value,samples,window_start,window_end,event_ids)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        randomUUID(),
        incidentId,
        item.ruleId,
        serviceId,
        item.metric,
        item.aggregation,
        item.threshold,
        item.value,
        item.samples,
        item.windowStart,
        item.windowEnd,
        item.eventIds,
      ],
    );
  }
  const ids = [...new Set(windows.flatMap((item) => item.eventIds))];
  if (ids.length)
    await client.query(
      "UPDATE monitoring_events SET incident_id=$2 WHERE id = ANY($1::text[]) AND incident_id IS NULL",
      [ids, incidentId],
    );
};
