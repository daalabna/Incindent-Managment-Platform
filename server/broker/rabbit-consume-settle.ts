import type { ConfirmChannel, ConsumeMessage, Options } from "amqplib";
import { formatError } from "../domain/errors";
import type { PostgresStore } from "../db/postgres";

const defaultRequeueDelayMs = 1500;

export type ConfirmPublish = (
  channel: ConfirmChannel,
  exchange: string,
  key: string,
  body: Buffer,
  options: Options.Publish,
) => Promise<void>;

export type SettleDeps = {
  store: PostgresStore;
  deadExchange: string;
  retryQueue: string;
  report: (message: string) => void;
  confirm: ConfirmPublish;
  requeueDelayMs?: number;
  durableBudget?: boolean;
};

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const publishOptions = (
  message: ConsumeMessage,
  attempts: number,
  statusOnly = false,
  invalidGeneration = false,
): Options.Publish => ({
  headers: {
    ...message.properties.headers,
    "x-retry-count": attempts,
    ...(statusOnly ? { "x-status-only": 1 } : {}),
    ...(invalidGeneration ? { "x-invalid-generation": 1 } : {}),
  },
  messageId: message.properties.messageId,
});

export const invalidGenerationMessage = (message: ConsumeMessage) => {
  const value = message.properties.headers?.["x-invalid-generation"];
  return value === 1 || value === true || value === "1";
};

/** Absent, null, empty, non-integer, or negative generation is invalid. */
export const readGeneration = (message: ConsumeMessage) => {
  const raw = message.properties.headers?.["x-generation"];
  if (raw === undefined || raw === null || raw === "")
    return { ok: false as const, value: 0 };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    return { ok: false as const, value };
  return { ok: true as const, value };
};

export const publishDead = async (
  channel: ConfirmChannel,
  message: ConsumeMessage,
  deps: SettleDeps,
  eventId: string | undefined,
  attempts: number,
) => {
  try {
    await deps.confirm(
      channel,
      deps.deadExchange,
      "dead",
      message.content,
      publishOptions(message, attempts),
    );
    return true;
  } catch (publishError) {
    deps.report(
      `Dead-letter publish failed eventId=${eventId ?? "unknown"} attempt=${attempts} ${formatError(publishError)}`,
    );
    return false;
  }
};

/** Returns false only when durable terminal was required and failed to commit. */
export const ensureTerminal = async (
  deps: SettleDeps,
  eventId: string | undefined,
  generation: number | null,
  reason: string,
) => {
  if (!deps.durableBudget || !eventId) return true;
  try {
    await deps.store.terminalDelivery(eventId, generation, reason);
    return true;
  } catch (error) {
    deps.report(
      `Terminal commit deferred eventId=${eventId} ${formatError(error)}`,
    );
    return false;
  }
};

const deadLetterNack = (
  channel: ConfirmChannel,
  message: ConsumeMessage,
  deps: SettleDeps,
  eventId: string | undefined,
) => {
  try {
    channel.nack(message, false, false);
  } catch (nackError) {
    deps.report(
      `Dead-letter nack failed eventId=${eventId ?? "unknown"} ${formatError(nackError)}`,
    );
  }
};

export const parkForRetry = async (
  channel: ConfirmChannel,
  message: ConsumeMessage,
  deps: SettleDeps,
  eventId: string | undefined,
  attempts: number,
  statusOnly = false,
  generation: number | null = null,
  invalidGeneration = false,
) => {
  try {
    await deps.confirm(
      channel,
      "",
      deps.retryQueue,
      message.content,
      publishOptions(message, attempts, statusOnly, invalidGeneration),
    );
    channel.ack(message);
  } catch (error) {
    deps.report(
      `Retry publish failed eventId=${eventId ?? "unknown"} attempt=${attempts} ${formatError(error)}`,
    );
    await pause(deps.requeueDelayMs ?? defaultRequeueDelayMs);
    const terminalOk = await ensureTerminal(
      deps,
      eventId,
      generation,
      "Retry park failed; dead-lettered",
    );
    // Never ack an app-DLQ publish unless durable terminal stuck (avoids DB limbo).
    if (
      terminalOk &&
      (await publishDead(channel, message, deps, eventId, attempts))
    ) {
      channel.ack(message);
      return;
    }
    deadLetterNack(channel, message, deps, eventId);
  }
};
