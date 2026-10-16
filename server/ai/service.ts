import { randomUUID } from "node:crypto";
import type { AnalysisJob } from "../../shared/ai";
import type { PostgresStore } from "../db/postgres";
import { saveAudit } from "../db/postgres-write";
import { createAudit } from "../domain/apply";
import { DomainError } from "../domain/errors";
import { collectContext, contextHash } from "./context";
import { promptVersion, type AiConfig } from "./config";
import { createProvider, type AnalysisProvider } from "./provider";
import { storedResultUsable } from "./stored-result";
import { AI_WORKER } from "../security/actors";
import { viewJob, type JobRow } from "./job-view";
import { processAnalysisJob } from "./process-job";

export class AiService {
  private provider: AnalysisProvider;
  constructor(
    private store: PostgresStore,
    readonly config: AiConfig,
    provider?: AnalysisProvider,
  ) {
    this.provider = provider ?? createProvider(config);
  }
  private view = (row: JobRow, stale: boolean): AnalysisJob =>
    viewJob(row, stale);
  status = (id: string) =>
    this.store.transaction(async (client) => {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const context = await collectContext(client, id);
      const hash = contextHash(context);
      const matched = (
        await client.query<JobRow>(
          `SELECT * FROM ai_analyses WHERE incident_id=$1 AND context_hash=$2
      AND model=$3 AND prompt_version=$4 AND state <> 'failed' AND reusable ORDER BY created_at DESC,id DESC LIMIT 1`,
          [id, hash, this.config.model, promptVersion],
        )
      ).rows[0];
      const latest =
        matched ??
        (
          await client.query<JobRow>(
            "SELECT * FROM ai_analyses WHERE incident_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
            [id],
          )
        ).rows[0];
      const stale =
        Boolean(latest) &&
        !matched &&
        (latest!.context_hash !== hash ||
          latest!.model !== this.config.model ||
          latest!.prompt_version !== promptVersion);
      return {
        enabled: this.config.enabled,
        reason: this.config.enabled
          ? null
          : "AI отключён. Включите AI_ENABLED на сервере и worker.",
        job: latest ? this.view(latest, stale) : null,
      };
    });
  request = (id: string, version: number, actor: string) =>
    this.store.transaction(async (client) => {
      if (!this.config.enabled)
        throw new DomainError("AI отключён в этом окружении.", 503);
      // Serializes tenant budgets and deduplication; no model call is made inside this transaction.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':ai',0))",
      );
      await client.query("SELECT id FROM incidents WHERE id=$1 FOR UPDATE", [
        id,
      ]);
      const context = await collectContext(client, id);
      if (context.incidentVersion !== version)
        throw new DomainError(
          "Incident changed. Refresh before requesting analysis.",
          409,
        );
      const hash = contextHash(context);
      const cached = (
        await client.query<JobRow>(
          `SELECT * FROM ai_analyses WHERE incident_id=$1 AND context_hash=$2
      AND model=$3 AND prompt_version=$4 AND state <> 'failed' AND reusable LIMIT 1`,
          [id, hash, this.config.model, promptVersion],
        )
      ).rows[0];
      if (
        cached &&
        !storedResultUsable(
          cached.state,
          cached.result,
          cached.context_retained ? cached.context : null,
        )
      )
        await client.query(
          "UPDATE ai_analyses SET reusable=false WHERE id=$1",
          [cached.id],
        );
      else if (cached) return this.view(cached, false);
      // Throttle in-flight and same hash+model+prompt; allow refresh on new context or model.
      const recent = await client.query(
        `SELECT id FROM ai_analyses WHERE incident_id=$1
      AND (state IN ('queued','running')
        OR (created_at > now()-interval '1 minute' AND state='failed' AND context_hash=$2 AND model=$3 AND prompt_version=$4)
        OR (created_at > now()-interval '1 minute' AND reusable AND context_hash=$2 AND model=$3 AND prompt_version=$4)) LIMIT 1`,
        [id, hash, this.config.model, promptVersion],
      );
      if (recent.rowCount)
        throw new DomainError(
          "Анализ уже выполняется или был запрошен меньше минуты назад.",
          429,
        );
      const count = (
        await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM ai_analyses WHERE created_at>now()-interval '24 hours'",
        )
      ).rows[0]!.count;
      if (count >= this.config.dailyLimit)
        throw new DomainError(
          "Достигнут суточный лимит AI-анализов workspace.",
          429,
        );
      const row = (
        await client.query<JobRow>(
          `INSERT INTO ai_analyses(id,incident_id,incident_version,context_hash,context,model,prompt_version,requested_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            randomUUID(),
            id,
            version,
            hash,
            context,
            this.config.model,
            promptVersion,
            actor,
          ],
        )
      ).rows[0]!;
      await saveAudit(client, [
        createAudit(
          `AI analysis ${row.id} requested for ${id} v${version}`,
          actor,
        ),
      ]);
      return this.view(row, false);
    });
  publishPending = async (publish: (id: string) => Promise<void>) => {
    await this.store.transaction(async (client) => {
      const expired = await client.query<{
        id: string;
      }>(`UPDATE ai_analyses SET state='failed',error='Истёк срок выполнения AI-задачи.',
        completed_at=now(),lease_token=NULL,lease_until=NULL WHERE state IN ('queued','running')
        AND (deadline_at<=now() OR (state='running' AND lease_until<=now() AND attempts>=2)) RETURNING id`);
      for (const row of expired.rows)
        await saveAudit(client, [
          createAudit(`AI analysis ${row.id} expired`, AI_WORKER),
        ]);
      await client.query(`UPDATE ai_analyses SET state='queued',published_at=NULL,lease_token=NULL,lease_until=NULL
        WHERE state='running' AND lease_until<=now() AND attempts<2`);
    });
    const id = await this.store.transaction(async (client) => {
      const row = (
        await client.query<{
          id: string;
        }>(`SELECT id FROM ai_analyses WHERE state='queued' AND available_at<=now()
        AND (published_at IS NULL OR published_at<now()-interval '90 seconds') ORDER BY created_at
        FOR UPDATE SKIP LOCKED LIMIT 1`)
      ).rows[0];
      if (!row) return;
      await client.query(
        "UPDATE ai_analyses SET published_at=now() WHERE id=$1",
        [row.id],
      );
      return row.id;
    });
    if (!id) return;
    try {
      await publish(id);
    } catch (error) {
      await this.store.pool.query(
        `UPDATE ai_analyses SET published_at=NULL WHERE id=$1 AND state='queued'`,
        [id],
      );
      throw error;
    }
  };
  process = (id: string) => processAnalysisJob(this.store, this.provider, id);
}
