import { randomUUID } from "node:crypto";
import type { PostgresStore } from "../db/postgres";
import { saveAudit } from "../db/postgres-write";
import { createAudit } from "../domain/apply";
import { citeLimitations } from "./context";
import { AiFailure, validateAnalysis, type AnalysisProvider } from "./provider";
import { traced } from "../observability/telemetry";
import { AI_WORKER } from "../security/actors";
import type { JobRow } from "./job-view";

export const processAnalysisJob = async (
  store: PostgresStore,
  provider: AnalysisProvider,
  id: string,
) => {
  const lease = randomUUID();
  const row = (
    await store.pool.query<JobRow>(
      `UPDATE ai_analyses SET state='running',attempts=attempts+1,
      lease_token=$2,lease_until=now()+interval '90 seconds' WHERE id=$1 AND state='queued' AND attempts<2
      AND available_at<=now() AND deadline_at>now() RETURNING *`,
      [id, lease],
    )
  ).rows[0];
  if (!row) return;
  const started = Date.now();
  try {
    const output = await traced("ai.incident.analyze", () =>
      provider(row.context, row.model),
    );
    const result = validateAnalysis(
      output.result,
      citeLimitations(row.context),
    );
    await store.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE ai_analyses SET state='succeeded',result=$3,input_tokens=$4,output_tokens=$5,
          estimated_cost_usd=$6,duration_ms=$7,completed_at=now(),lease_token=NULL,lease_until=NULL,error=NULL
          WHERE id=$1 AND lease_token=$2 AND state='running'`,
        [
          id,
          lease,
          result,
          output.inputTokens,
          output.outputTokens,
          output.estimatedCostUsd,
          Date.now() - started,
        ],
      );
      if (updated.rowCount)
        await saveAudit(client, [
          createAudit(
            `AI analysis ${id} completed for ${row.incident_id}; operator review required`,
            AI_WORKER,
          ),
        ]);
    });
  } catch (error) {
    const failure =
      error instanceof AiFailure
        ? error
        : new AiFailure("Не удалось завершить AI-анализ.");
    const retry = failure.retryable && row.attempts < 2;
    await store.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE ai_analyses SET state=$3,error=$4,duration_ms=$5,published_at=NULL,
          available_at=now()+interval '30 seconds',completed_at=CASE WHEN $3='failed' THEN now() ELSE NULL END,
          lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state='running'`,
        [
          id,
          lease,
          retry ? "queued" : "failed",
          failure.message,
          Date.now() - started,
        ],
      );
      if (updated.rowCount)
        await saveAudit(client, [
          createAudit(
            `AI analysis ${id} ${retry ? "retry scheduled" : "failed"}: ${failure.message}`,
            AI_WORKER,
          ),
        ]);
    });
  }
};
