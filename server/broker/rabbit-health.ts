import type { ConfirmChannel } from "amqplib";
import type { PostgresStore } from "../db/postgres";

export type RabbitAiHealth = {
  status: "up" | "down" | "disabled";
  connected: boolean;
  consumers: number;
  queued: number | null;
  oldestQueuedMs: number | null;
};

export type RabbitHealthReport = {
  connected: boolean;
  consumers: number;
  queued: number;
  dead: number;
  ai: RabbitAiHealth;
};

const aiDisabled: RabbitAiHealth = {
  status: "disabled",
  connected: false,
  consumers: 0,
  queued: null,
  oldestQueuedMs: null,
};

export const reportRabbitHealth = async (
  connected: boolean,
  channel: ConfirmChannel | undefined,
  store: PostgresStore,
  queues: { main: string; dead: string },
  extension?: {
    health?: () => Promise<{
      ready: boolean;
      connected: boolean;
      consumers: number;
      queued: number | null;
    }>;
  },
): Promise<RabbitHealthReport> => {
  if (!connected || !channel)
    return {
      connected: false,
      consumers: 0,
      queued: 0,
      dead: 0,
      ai: aiDisabled,
    };
  const main = await channel.checkQueue(queues.main);
  const dead = await channel.checkQueue(queues.dead);
  const ai = await extension?.health?.().catch(() => ({
    ready: false,
    connected: false,
    consumers: 0,
    queued: null as number | null,
  }));
  const age = ai
    ? await store.pool
        .query<{ age: string | number | null }>(
          `SELECT (extract(epoch FROM now()-min(created_at))*1000)::bigint AS age FROM ai_analyses WHERE state IN ('queued','running')`,
        )
        .catch(() => undefined)
    : undefined;
  const rawAge = age?.rows[0]?.age;
  const oldest =
    rawAge === null || rawAge === undefined ? Number.NaN : Number(rawAge);
  const oldestQueuedMs =
    Number.isFinite(oldest) && oldest >= 0 ? Math.trunc(oldest) : null;
  return {
    connected: true,
    consumers: main.consumerCount,
    queued: main.messageCount,
    dead: dead.messageCount,
    ai: ai
      ? {
          status: ai.ready ? "up" : "down",
          connected: ai.connected,
          consumers: ai.consumers,
          queued: ai.queued,
          oldestQueuedMs,
        }
      : aiDisabled,
  };
};
