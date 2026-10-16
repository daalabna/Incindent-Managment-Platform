import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { DomainError, formatError } from "../domain/errors";
import type { PostgresStore } from "../db/postgres";
import { deliveryBudget } from "../db/delivery-budget";
import {
  invalidGenerationMessage,
  parkForRetry,
  publishDead,
  readGeneration,
  type ConfirmPublish,
  type SettleDeps,
} from "./rabbit-consume-settle";

type DeliveryDeps = SettleDeps & {
  store: PostgresStore;
  onChange: (notice: { incidentId: string | null }) => Promise<void>;
  confirm: ConfirmPublish;
};

const statusOnlyMessage = (message: ConsumeMessage) => {
  const value = message.properties.headers?.["x-status-only"];
  return value === 1 || value === true || value === "1";
};

const eventIdOf = (message: ConsumeMessage) => {
  const envelope: unknown = JSON.parse(message.content.toString());
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !("eventId" in envelope) ||
    typeof envelope.eventId !== "string"
  )
    throw new DomainError("Invalid event envelope");
  return envelope.eventId;
};

const failureSql =
  "UPDATE monitoring_events SET failure='Processing failed after retries; inspect dead-letter queue' WHERE id=$1 AND processed_at IS NULL";

const settleFailure = async (
  channel: ConfirmChannel,
  message: ConsumeMessage,
  deps: DeliveryDeps,
  eventId: string | undefined,
  attempts: number,
) => {
  if (!eventId) {
    channel.ack(message);
    return;
  }
  try {
    await deps.store.pool.query(failureSql, [eventId]);
    channel.ack(message);
  } catch (statusError) {
    deps.report(
      `Dead-letter status failed eventId=${eventId} ${formatError(statusError)}`,
    );
    await parkForRetry(channel, message, deps, eventId, attempts, true, null);
  }
};

/** First delivery with invalid/missing generation: terminalize current DB gen + DLQ. */
const settleInvalidGeneration = async (
  channel: ConfirmChannel,
  message: ConsumeMessage,
  deps: DeliveryDeps,
  eventId: string,
  attempts: number,
) => {
  deps.report(`Invalid x-generation for eventId=${eventId}; sending to DLQ`);
  try {
    await deps.store.terminalDelivery(
      eventId,
      null,
      "Invalid or missing x-generation header",
    );
  } catch (storageError) {
    deps.report(
      `Terminal commit deferred eventId=${eventId} ${formatError(storageError)}`,
    );
    await parkForRetry(
      channel,
      message,
      deps,
      eventId,
      attempts,
      true,
      null,
      true,
    );
    return;
  }
  if (!(await publishDead(channel, message, deps, eventId, attempts))) {
    await parkForRetry(
      channel,
      message,
      deps,
      eventId,
      attempts,
      true,
      null,
      true,
    );
    return;
  }
  channel.ack(message);
};

const handleStatusOnly = async (
  channel: ConfirmChannel,
  message: ConsumeMessage,
  deps: DeliveryDeps,
  attempts: number,
  generation: ReturnType<typeof readGeneration>,
) => {
  let eventId: string | undefined;
  try {
    eventId = eventIdOf(message);
  } catch (error) {
    deps.report(
      `Dead-letter status failed eventId=unknown ${formatError(error)}`,
    );
    channel.ack(message);
    return;
  }
  if (deps.durableBudget) {
    // Bare missing/invalid gen without retry marker: drop (safe after replay).
    // Marked invalid-gen retry: terminalize current DB gen (null).
    // Known foreign gen after replay: terminalDelivery no-ops on mismatch.
    if (!generation.ok && !invalidGenerationMessage(message)) {
      deps.report(
        `Status-only message with invalid x-generation dropped eventId=${eventId}`,
      );
      channel.ack(message);
      return;
    }
    const gen = generation.ok ? generation.value : null;
    const invalidGen = !generation.ok;
    try {
      await deps.store.terminalDelivery(
        eventId,
        gen,
        invalidGen
          ? "Invalid or missing x-generation header"
          : "Processing failed after retries; inspect dead-letter queue",
      );
      channel.ack(message);
    } catch (statusError) {
      deps.report(
        `Dead-letter status failed eventId=${eventId} ${formatError(statusError)}`,
      );
      await parkForRetry(
        channel,
        message,
        deps,
        eventId,
        attempts,
        true,
        gen,
        invalidGen,
      );
    }
    return;
  }
  await settleFailure(channel, message, deps, eventId, attempts);
};

export const processDelivery = async (
  channel: ConfirmChannel,
  message: ConsumeMessage,
  deps: DeliveryDeps,
) => {
  const attempts = Number(message.properties.headers?.["x-retry-count"] ?? 0);
  const generation = readGeneration(message);
  if (statusOnlyMessage(message)) {
    await handleStatusOnly(channel, message, deps, attempts, generation);
    return;
  }
  let eventId: string | undefined;
  let incidentId: string | null = null;
  try {
    eventId = eventIdOf(message);
    if (deps.durableBudget) {
      if (!generation.ok) {
        await settleInvalidGeneration(
          channel,
          message,
          deps,
          eventId,
          attempts,
        );
        return;
      }
      const result = await deps.store.processDelivery(
        eventId,
        generation.value,
      );
      if ("skipped" in result || "terminal" in result) {
        channel.ack(message);
        return;
      }
      incidentId = "incidentId" in result ? result.incidentId : null;
    } else {
      const result = await deps.store.processEvent(eventId);
      incidentId = "incidentId" in result ? result.incidentId : null;
    }
  } catch (error) {
    const terminal =
      error instanceof DomainError ||
      error instanceof SyntaxError ||
      attempts >= deliveryBudget.rabbitTerminalAfter;
    deps.report(
      `Processing ${terminal ? "failed" : "retry"} eventId=${eventId ?? "unknown"} attempt=${attempts} ${formatError(error)}`,
    );
    if (terminal) {
      if (deps.durableBudget && eventId) {
        try {
          await deps.store.terminalDelivery(
            eventId,
            generation.ok ? generation.value : null,
            "Processing failed after retries; inspect dead-letter queue",
          );
        } catch (storageError) {
          deps.report(
            `Terminal commit deferred eventId=${eventId} ${formatError(storageError)}`,
          );
          await parkForRetry(
            channel,
            message,
            deps,
            eventId,
            attempts,
            true,
            generation.ok ? generation.value : null,
          );
          return;
        }
      }
      if (!(await publishDead(channel, message, deps, eventId, attempts))) {
        await parkForRetry(
          channel,
          message,
          deps,
          eventId,
          attempts,
          Boolean(deps.durableBudget && eventId),
          generation.ok ? generation.value : null,
        );
        return;
      }
      if (deps.durableBudget) channel.ack(message);
      else await settleFailure(channel, message, deps, eventId, attempts);
    } else
      await parkForRetry(
        channel,
        message,
        deps,
        eventId,
        attempts + 1,
        false,
        generation.ok ? generation.value : null,
      );
    return;
  }
  channel.ack(message);
  await deps.onChange({ incidentId }).catch((error: unknown) => {
    deps.report(
      `Realtime notification failed eventId=${eventId ?? "unknown"} ${formatError(error)}`,
    );
  });
};
