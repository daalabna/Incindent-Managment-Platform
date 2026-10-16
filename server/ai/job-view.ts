import {
  analysisJobSchema,
  type AnalysisJob,
  type IncidentAnalysis,
} from "../../shared/ai";
import type { AnalysisContext } from "./context";
import {
  incompatibleMessage,
  resultAttestedLimitation,
  storedResultUsable,
} from "./stored-result";
import { promptVersion } from "./config";

export type JobRow = {
  id: string;
  incident_id: string;
  incident_version: number;
  context_hash: string;
  context: AnalysisContext;
  state: AnalysisJob["state"];
  model: string;
  prompt_version: string;
  attempts: number;
  context_retained: boolean;
  reusable: boolean;
  created_at: Date;
  completed_at: Date | null;
  result: IncidentAnalysis | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  duration_ms: number | null;
};

export const viewJob = (row: JobRow, stale: boolean): AnalysisJob => {
  const shared = {
    id: row.id,
    incidentId: row.incident_id,
    incidentVersion: row.incident_version,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at.toISOString(),
    stale,
    contextRetained: row.context_retained,
    attempts: row.attempts,
    sources: row.context.sources,
    limitations: row.context.limitations,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    durationMs: row.duration_ms,
  };
  if (row.state === "succeeded") {
    // Purged empty sources: show only if retention attested the result.
    // Otherwise always revalidate (including retained=false with sources).
    const archival = !row.context_retained && row.context.sources.length === 0;
    const attested =
      archival && row.context.limitations.includes(resultAttestedLimitation);
    const current =
      row.prompt_version === promptVersion &&
      row.result != null &&
      (attested ||
        (!archival && storedResultUsable(row.state, row.result, row.context)));
    if (!current)
      return analysisJobSchema.parse({
        ...shared,
        state: "incompatible",
        result: null,
        error: incompatibleMessage,
        completedAt:
          row.completed_at?.toISOString() ?? row.created_at.toISOString(),
      });
    return analysisJobSchema.parse({
      ...shared,
      state: "succeeded",
      result: row.result,
      error: null,
      completedAt: row.completed_at?.toISOString() ?? null,
    });
  }
  if (row.state === "failed")
    return analysisJobSchema.parse({
      ...shared,
      state: "failed",
      result: null,
      error: row.error ?? "Анализ не выполнен.",
      completedAt: row.completed_at?.toISOString() ?? null,
    });
  if (row.state === "running")
    return analysisJobSchema.parse({
      ...shared,
      state: "running",
      result: null,
      error: null,
      completedAt: null,
    });
  return analysisJobSchema.parse({
    ...shared,
    state: "queued",
    result: null,
    error: null,
    completedAt: null,
  });
};
