import { z } from "zod";

export const stepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("note"), text: z.string().min(1).max(2000) }),
  z.object({
    type: z.literal("wait"),
    seconds: z.number().int().min(1).max(3600),
  }),
  z.object({
    type: z.literal("check_health"),
    serviceId: z.string().min(1),
    retrySeconds: z.number().int().min(1).max(300).default(5),
  }),
  z.object({ type: z.literal("assign"), assignee: z.string().min(1).max(80) }),
  z.object({ type: z.literal("notify"), text: z.string().min(1).max(2000) }),
]);
export const runbookSchema = z.object({
  name: z.string().min(1).max(120),
  steps: z.array(stepSchema).min(1).max(30),
  timeoutSeconds: z.number().int().min(1).max(86400).default(300),
});
export type RunbookDefinition = z.infer<typeof runbookSchema>;
export const runStateSchema = z.enum([
  "running",
  "compensating",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "compensation_failed",
]);
export type RunState = z.infer<typeof runStateSchema>;
export const replaySchema = z.object({
  generation: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(500),
});
export const operationPage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().optional(),
  });
export const failedJobSchema = z.object({
  event_id: z.string(),
  generation: z.number().int().nonnegative(),
  reason: z.string(),
  replayed_at: z.string().nullable(),
});
export const dependencySchema = z.object({
  service_id: z.string(),
  depends_on: z.string(),
});
export const runbookRowSchema = z.object({ id: z.string(), name: z.string() });
export const runbookRunSchema = z.object({
  id: z.string(),
  incident_id: z.string(),
  state: runStateSchema,
  step: z.number().int().nonnegative(),
  steps: z.number().int().positive(),
  available_at: z.string(),
  deadline_at: z.string(),
  error: z.string().nullable(),
  version: z.number().int().nonnegative(),
});
export const notificationRowSchema = z.object({
  id: z.string(),
  incident_id: z.string(),
  adapter: z.string(),
  state: z.enum(["pending", "sending", "sent", "failed", "audit_pending"]),
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
