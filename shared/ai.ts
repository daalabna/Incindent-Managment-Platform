import { z } from "zod";

const statement = z
  .object({
    text: z.string().min(1).max(1600),
    sources: z.array(z.string()).min(1).max(8),
  })
  .strict();
/** Server-enriched after validation; models must not invent these. */
export const analysisStatusesSchema = z
  .object({
    rootCause: z.enum(["observed", "unconfirmed"]),
    missingData: z.array(z.enum(["gap", "limitation_ref"])),
  })
  .strict();

export const analysisSchema = z
  .object({
    summary: statement,
    facts: z.array(statement).max(8),
    hypotheses: z
      .array(
        z
          .object({
            title: z.string().max(200),
            explanation: z.string().max(1600),
            supportingSources: z.array(z.string()).min(1).max(8),
            counterEvidence: z.string().max(1000),
            verification: z.string().max(1000),
          })
          .strict(),
      )
      .max(4),
    nextChecks: z
      .array(
        z
          .object({
            action: z.string().max(1000),
            reason: z.string().max(1000),
            sources: z.array(z.string()).min(1).max(8),
          })
          .strict(),
      )
      .max(6),
    missingData: z.array(z.string().max(500)).max(8),
    postmortem: z
      .object({
        impact: statement,
        timeline: z.array(statement).max(10),
        rootCause: statement,
        actionsTaken: z.array(statement).max(8),
        prevention: z.array(statement).max(6),
      })
      .strict(),
    statuses: analysisStatusesSchema.optional(),
  })
  .strict();
export type IncidentAnalysis = z.infer<typeof analysisSchema>;
/** Model-facing contract — statuses are server-enriched only. */
export const modelAnalysisSchema = analysisSchema.omit({ statuses: true });

export const evidenceSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "incident",
    "timeline",
    "event",
    "service",
    "rule",
    "dependency",
    "limitation",
  ]),
  label: z.string(),
  text: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;
const jobFields = {
  id: z.string().uuid(),
  incidentId: z.string(),
  incidentVersion: z.number().int(),
  model: z.string(),
  promptVersion: z.string(),
  createdAt: z.string(),
  stale: z.boolean(),
  contextRetained: z.boolean(),
  attempts: z.number().int(),
  sources: z.array(evidenceSchema),
  limitations: z.array(z.string()),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  estimatedCostUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
};
export const analysisJobSchema = z.discriminatedUnion("state", [
  z.object({
    ...jobFields,
    state: z.literal("queued"),
    result: z.null(),
    error: z.null(),
    completedAt: z.null(),
  }),
  z.object({
    ...jobFields,
    state: z.literal("running"),
    result: z.null(),
    error: z.null(),
    completedAt: z.null(),
  }),
  z.object({
    ...jobFields,
    state: z.literal("succeeded"),
    result: analysisSchema,
    error: z.null(),
    completedAt: z.string(),
  }),
  z.object({
    ...jobFields,
    state: z.literal("incompatible"),
    result: z.null(),
    error: z.string(),
    completedAt: z.string(),
  }),
  z.object({
    ...jobFields,
    state: z.literal("failed"),
    result: z.null(),
    error: z.string(),
    completedAt: z.string(),
  }),
]);
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export const analysisResponseSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().nullable(),
  job: analysisJobSchema.nullable(),
});
