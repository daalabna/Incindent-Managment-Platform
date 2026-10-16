import {
  healthResponseSchema,
  type HealthResponse,
} from "../../shared/contracts";

const unavailableHealth = {
  status: "degraded",
  mode: "distributed",
  storage: "postgresql",
  postgres: { status: "down" },
  redis: { status: "down" },
  rabbitmq: { status: "down" },
  ai: {
    status: "disabled",
    connected: false,
    consumers: 0,
    queued: null,
    oldestQueuedMs: null,
  },
} satisfies HealthResponse;

export const encodeHealth = (
  body: unknown,
): { statusCode: number; body: HealthResponse } => {
  const parsed = healthResponseSchema.safeParse(body);
  if (!parsed.success) return { statusCode: 503, body: unavailableHealth };
  return {
    statusCode: parsed.data.status === "ok" ? 200 : 503,
    body: parsed.data,
  };
};
