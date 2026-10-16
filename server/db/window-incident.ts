import type { PoolClient } from "pg";
import type { RuleEvidence } from "../domain/windows";
import { applyWindowMatch } from "../domain/apply";
import { advisoryLockSql } from "./locks";
import {
  commitIngest,
  correlationState,
  loadServiceContext,
  lockOpenIncidents,
} from "./postgres-ingest";
import { saveRuleMatches } from "./rule-matches";

export const openWindowIncident = async (
  client: PoolClient,
  source: string,
  evidence: RuleEvidence[],
) => {
  if (!evidence.length) return;
  await client.query(advisoryLockSql("events"));
  const context = await loadServiceContext(client, source);
  const state = correlationState(
    context.services,
    context.rules,
    await lockOpenIncidents(client, context.related),
  );
  const result = applyWindowMatch(state, source, evidence, context.related);
  const committed = await commitIngest(client, state, result);
  if (committed.incidentId)
    await saveRuleMatches(client, source, committed.incidentId, evidence);
};
