import type { HealthResponse } from "../../shared/contracts";
import { healthPolicy } from "../../shared/domain";

type Stats = {
  pending: number;
  retrying: number;
  failed: number;
  oldestPendingAgeMs: number | null;
  lastProcessedAt: string | null;
};

type RabbitHealth = {
  connected: boolean;
  consumers: number;
  queued: number;
  dead: number;
  ai: {
    status: "up" | "down" | "disabled";
    connected: boolean;
    consumers: number;
    queued: number | null;
    oldestQueuedMs: number | null;
  };
};

const aiDisabled = {
  status: "disabled" as const,
  connected: false,
  consumers: 0,
  queued: null as number | null,
  oldestQueuedMs: null as number | null,
};

/** Core API readiness ignores AI; operators read `ai.status` separately. */
export const distributedHealth = (
  postgres: PromiseSettledResult<Stats>,
  redis: PromiseSettledResult<boolean>,
  rabbit: PromiseSettledResult<RabbitHealth>,
): HealthResponse => {
  const dbOk = postgres.status === "fulfilled";
  const redisOk = redis.status === "fulfilled" && redis.value;
  const rabbitOk = rabbit.status === "fulfilled" && rabbit.value.connected;
  const consumers = rabbit.status === "fulfilled" ? rabbit.value.consumers : 0;
  const stuck =
    dbOk &&
    postgres.value.oldestPendingAgeMs !== null &&
    postgres.value.oldestPendingAgeMs > healthPolicy.stuckOutboxMs;
  const ai = rabbit.status === "fulfilled" ? rabbit.value.ai : aiDisabled;
  return {
    status:
      dbOk && redisOk && rabbitOk && consumers > 0 && !stuck
        ? "ok"
        : "degraded",
    mode: "distributed",
    storage: "postgresql",
    postgres: dbOk
      ? { status: "up", outbox: postgres.value }
      : { status: "down" },
    redis: { status: redisOk ? "up" : "down" },
    rabbitmq:
      rabbitOk && rabbit.status === "fulfilled"
        ? {
            status: "up",
            connected: rabbit.value.connected,
            consumers: rabbit.value.consumers,
            queued: rabbit.value.queued,
            dead: rabbit.value.dead,
          }
        : { status: "down" },
    ai,
  };
};
