import { z } from "zod";
import {
  eventTypes,
  healthPolicy,
  healthStates,
  ruleMetrics,
  severities,
  statuses,
} from "./domain";

const finite = z.number().finite();
const observationSchema = z.object({
  value: finite,
  sequence: z.number().int().nonnegative(),
  at: z.string(),
});

export const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  health: z.enum(healthStates),
  latency: finite,
  errorRate: finite,
  history: z.array(finite),
  observations: z.object({
    latency: observationSchema.optional(),
    error_rate: observationSchema.optional(),
    health: observationSchema.optional(),
  }),
});

export const timelineEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.string(),
  text: z.string(),
});

export const incidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  serviceId: z.string(),
  severity: z.enum(severities),
  status: z.enum(statuses),
  assignee: z.string().nullable(),
  alerts: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  timeline: z.array(timelineEntrySchema),
});

export const incidentSummarySchema = incidentSchema.omit({ timeline: true });

const ruleFields = {
  serviceId: z.string().min(1).max(128),
  metric: z.enum(ruleMetrics),
  threshold: finite,
  severity: z.enum(severities),
  windowSeconds: z.number().int().min(0).max(3600).optional(),
  allowedLatenessSeconds: z.number().int().min(0).max(300).optional(),
  minSamples: z.number().int().min(1).max(10000).optional(),
  aggregation: z.enum(["avg", "max", "all"]).optional(),
};

const checkThreshold = (
  rule: { metric: "error_rate" | "latency"; threshold: number },
  ctx: z.RefinementCtx,
) => {
  const max =
    rule.metric === "latency"
      ? healthPolicy.maxLatencyMs
      : healthPolicy.maxErrorRate;
  if (rule.threshold < 0 || rule.threshold > max)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["threshold"],
      message: `${rule.metric} threshold must be between 0 and ${max}`,
    });
};

export const ruleSchema = z
  .object({ ...ruleFields, enabled: z.boolean().default(true) })
  .superRefine(checkThreshold);
export const storedRuleSchema = z
  .object({ ...ruleFields, enabled: z.boolean(), id: z.string() })
  .superRefine(checkThreshold);
export const messageSchema = z.object({ message: z.string() });
export const auditEntrySchema = timelineEntrySchema.extend({
  incidentId: z.string().nullable(),
});

export const eventSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .default(() => crypto.randomUUID()),
    source: z.string().min(1).max(128),
    type: z.enum(eventTypes),
    value: finite,
    timestamp: z
      .string()
      .datetime()
      .default(() => new Date().toISOString()),
  })
  .superRefine((event, ctx) => {
    if (event.type === "health" && event.value !== 0 && event.value !== 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "health must be 0 or 1",
      });
    if (
      event.type === "error_rate" &&
      (event.value < 0 || event.value > healthPolicy.maxErrorRate)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `error_rate must be between 0 and ${healthPolicy.maxErrorRate}`,
      });
    if (
      event.type === "latency" &&
      (event.value < 0 || event.value > healthPolicy.maxLatencyMs)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `latency must be between 0 and ${healthPolicy.maxLatencyMs}`,
      });
  });

export const incidentUpdateSchema = z
  .object({
    version: z.number().int().positive(),
    status: z.enum(statuses).optional(),
    assignee: z.string().min(1).max(80).nullable().optional(),
    severity: z.enum(severities).optional(),
    comment: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((value) => Object.keys(value).length > 1, "Provide an update");

export const eventReceiptSchema = z.discriminatedUnion("status", [
  z.object({
    eventId: z.string(),
    duplicate: z.boolean(),
    status: z.literal("queued"),
    incidentId: z.null(),
  }),
  z.object({
    eventId: z.string(),
    duplicate: z.boolean(),
    status: z.literal("processed"),
    incidentId: z.string().nullable(),
  }),
  z.object({
    eventId: z.string(),
    duplicate: z.boolean(),
    status: z.literal("failed"),
    incidentId: z.string().nullable(),
    error: z.string(),
  }),
]);

const outboxStatsSchema = z.object({
  pending: z.number().int().nonnegative(),
  retrying: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  oldestPendingAgeMs: z.number().finite().nullable(),
  lastProcessedAt: z.string().nullable(),
});

export const healthResponseSchema = z.discriminatedUnion("mode", [
  z.object({
    status: z.literal("ok"),
    mode: z.literal("local"),
    storage: z.literal("sqlite"),
  }),
  z.object({
    status: z.enum(["ok", "degraded"]),
    mode: z.literal("distributed"),
    storage: z.literal("postgresql"),
    postgres: z.object({
      status: z.enum(["up", "down"]),
      outbox: outboxStatsSchema.optional(),
    }),
    redis: z.object({ status: z.enum(["up", "down"]) }),
    rabbitmq: z.object({
      status: z.enum(["up", "down"]),
      connected: z.boolean().optional(),
      consumers: z.number().int().nonnegative().optional(),
      queued: z.number().int().nonnegative().optional(),
      dead: z.number().int().nonnegative().optional(),
    }),
    ai: z.object({
      status: z.enum(["up", "down", "disabled"]),
      connected: z.boolean(),
      consumers: z.number().int().nonnegative(),
      queued: z.number().int().nonnegative().nullable(),
      oldestQueuedMs: z.number().int().nonnegative().nullable(),
    }),
  }),
]);

export const summarySchema = z.object({
  services: z.array(serviceSchema),
  incidents: z.array(incidentSummarySchema),
  resolvedCount: z.number().int().nonnegative(),
  rules: z.array(storedRuleSchema),
  audit: z.array(auditEntrySchema),
  eventCount: z.number().int().nonnegative(),
});

export const incidentPageSchema = z.object({
  items: z.array(incidentSummarySchema),
  nextCursor: z.string().nullable(),
});

export const activityPageSchema = z.object({
  items: z.array(auditEntrySchema),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const snapshotSchema = z.object({
  services: z.array(serviceSchema),
  incidents: z.array(incidentSchema),
  rules: z.array(storedRuleSchema),
  audit: z.array(auditEntrySchema),
  events: z.array(eventSchema),
  receptionSequence: z.number().int().nonnegative(),
});

export type EventInput = z.infer<typeof eventSchema>;
export type RuleInput = z.infer<typeof ruleSchema>;
export type IncidentPatch = Omit<
  z.infer<typeof incidentUpdateSchema>,
  "version"
>;
export type EventReceipt = z.infer<typeof eventReceiptSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type SummaryResponse = z.infer<typeof summarySchema>;
export type IncidentPage = z.infer<typeof incidentPageSchema>;
export type ActivityPage = z.infer<typeof activityPageSchema>;
