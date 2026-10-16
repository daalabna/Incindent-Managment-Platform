import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createAudit } from "../domain/apply";
import { saveAudit } from "../db/postgres-write";
import { advisoryLockSql } from "../db/locks";
import type { AnalysisContext } from "../ai/context";
import {
  incompatibleMessage,
  resultAttestedLimitation,
  storedResultUsable,
} from "../ai/stored-result";

const purgeNote = "Контекст удалён политикой хранения.";
const retainedContext = (limitationsSql: string) =>
  `jsonb_build_object('incidentId',incident_id,'incidentVersion',incident_version,'sources','[]'::jsonb,'limitations',${limitationsSql})`;
const plainLimitations = `jsonb_build_array('${purgeNote}')`;
const attestedLimitations = `jsonb_build_array('${purgeNote}','${resultAttestedLimitation}')`;

/** Drop invented results before stripping context so purge cannot resurrect them. */
const clearUnusableResults = async (client: PoolClient, cutoff: Date) => {
  const aged = await client.query<{
    id: string;
    state: string;
    result: unknown;
    context: AnalysisContext;
  }>(
    `SELECT id, state, result, context FROM ai_analyses
     WHERE state IN ('succeeded','failed') AND completed_at<$1 AND context_retained`,
    [cutoff],
  );
  for (const row of aged.rows) {
    if (storedResultUsable(row.state, row.result, row.context)) continue;
    await client.query(
      `UPDATE ai_analyses SET result=NULL, error=$2 WHERE id=$1 AND state='succeeded'`,
      [row.id, incompatibleMessage],
    );
  }
};

const planSql = `SELECT
  (SELECT count(*)::int FROM monitoring_events WHERE payload IS NOT NULL
    AND (processed_at<$1 OR terminal_at<$1)) AS events,
  (SELECT count(*)::int FROM metric_samples WHERE event_at<$1) AS samples,
  (SELECT count(*)::int FROM ai_analyses WHERE state IN ('succeeded','failed') AND completed_at<$1 AND context_retained) AS analyses,
  (SELECT count(*)::int FROM incident_timeline WHERE at<$1 AND incident_id IN (
    SELECT id FROM incidents WHERE status='resolved' AND created_at<$1)) AS timelines,
  (SELECT count(*)::int FROM rule_matches WHERE window_end<$1
    AND incident_id IN (SELECT id FROM incidents WHERE status='resolved' AND created_at<$1)) AS "ruleMatches",
  (SELECT count(*)::int FROM audit_entries WHERE (payload->>'at')::timestamptz < $1
    AND (incident_id IS NULL OR incident_id NOT IN (SELECT id FROM incidents WHERE status <> 'resolved'))) AS audit,
  (SELECT count(*)::int FROM runbook_runs WHERE state IN ('succeeded','failed','cancelled','timed_out','compensation_failed') AND updated_at<$1) AS runs,
  (SELECT count(*)::int FROM notification_jobs WHERE state IN ('sent','failed') AND COALESCE(completed_at,created_at)<$1) AS notifications,
  (SELECT count(*)::int FROM dead_letters WHERE replayed_at IS NOT NULL AND replayed_at<$1) AS "deadLetters"`;

export const retain = async (
  client: PoolClient,
  days: number,
  dryRun: boolean,
  actor: string,
) => {
  const cutoff = new Date(Date.now() - days * 86400_000);
  if (!dryRun) {
    await client.query(advisoryLockSql("events"));
    await client.query(advisoryLockSql("retention"));
  }
  const counts = (
    await client.query<{
      events: number;
      samples: number;
      analyses: number;
      timelines: number;
      ruleMatches: number;
      audit: number;
      runs: number;
      notifications: number;
      deadLetters: number;
    }>(planSql, [cutoff])
  ).rows[0]!;
  if (!dryRun) {
    await client.query("DELETE FROM metric_samples WHERE event_at<$1", [
      cutoff,
    ]);
    // Strip aged payloads for processed and terminal-failed events (keep fingerprint for ID conflicts).
    await client.query(
      `UPDATE monitoring_events SET fingerprint=COALESCE(fingerprint,jsonb_build_object('source',payload->'source','type',payload->'type','value',payload->'value')),payload=NULL
      WHERE payload IS NOT NULL AND (processed_at<$1 OR terminal_at<$1)`,
      [cutoff],
    );
    await client.query(
      `DELETE FROM event_outbox WHERE event_id IN (
        SELECT id FROM monitoring_events WHERE processed_at<$1 OR terminal_at<$1)
        AND (published_at IS NULL OR published_at<$1)`,
      [cutoff],
    );
    await clearUnusableResults(client, cutoff);
    await client.query(
      `UPDATE ai_analyses SET
        context=CASE WHEN result IS NOT NULL THEN ${retainedContext(attestedLimitations)}
                     ELSE ${retainedContext(plainLimitations)} END,
        context_retained=false, reusable=false
       WHERE state IN ('succeeded','failed') AND completed_at<$1 AND context_retained`,
      [cutoff],
    );
    await client.query(
      `DELETE FROM rule_matches WHERE window_end<$1 AND incident_id IN (
        SELECT id FROM incidents WHERE status='resolved' AND created_at<$1)`,
      [cutoff],
    );
    await client.query(
      `DELETE FROM incident_timeline WHERE at<$1 AND incident_id IN (
        SELECT id FROM incidents WHERE status='resolved' AND created_at<$1)`,
      [cutoff],
    );
    await client.query(
      `DELETE FROM audit_entries WHERE (payload->>'at')::timestamptz < $1
      AND (incident_id IS NULL OR incident_id NOT IN (SELECT id FROM incidents WHERE status <> 'resolved'))`,
      [cutoff],
    );
    await client.query(
      `DELETE FROM runbook_runs WHERE state IN ('succeeded','failed','cancelled','timed_out','compensation_failed') AND updated_at<$1`,
      [cutoff],
    );
    await client.query(
      `DELETE FROM notification_jobs WHERE state IN ('sent','failed') AND COALESCE(completed_at,created_at)<$1`,
      [cutoff],
    );
    await client.query(
      "DELETE FROM dead_letters WHERE replayed_at IS NOT NULL AND replayed_at<$1",
      [cutoff],
    );
    await client.query(
      "INSERT INTO retention_runs(id,cutoff,result) VALUES($1,$2,$3)",
      [randomUUID(), cutoff, counts],
    );
    await saveAudit(client, [
      createAudit(
        `Retention: ${days} days, events ${counts.events}, samples ${counts.samples}, analyses ${counts.analyses}, timelines ${counts.timelines}, rule matches ${counts.ruleMatches}, audit ${counts.audit}, runs ${counts.runs}, notifications ${counts.notifications}, dead letters ${counts.deadLetters}`,
        actor,
      ),
    ]);
  }
  return { dryRun, cutoff: cutoff.toISOString(), ...counts };
};
