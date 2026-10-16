import amqp, {
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from "amqplib";
import { formatError } from "../domain/errors";
import { assertTopology, type RabbitNames } from "./rabbit-topology";

export type RabbitConnectHost = {
  url: string;
  worker: boolean;
  readonly stopped: boolean;
  generation: number;
  endpointIndex: number;
  names: () => RabbitNames;
  report: (message: string) => void;
  handle: (channel: ConfirmChannel, message: ConsumeMessage) => Promise<void>;
  inFlight: Set<Promise<void>>;
  abandon: (generation: number, connection: ChannelModel) => Promise<boolean>;
  scheduleReconnect: () => void;
  setConnected: (value: boolean) => void;
  extension?: {
    attach(connection: ChannelModel, worker: boolean): Promise<void>;
  };
  assign: (
    connection: ChannelModel,
    channel: ConfirmChannel,
    consumerTag?: string,
  ) => void;
};

export const connectRabbit = async (host: RabbitConnectHost) => {
  if (host.stopped) return;
  const generation = ++host.generation;
  let connection: ChannelModel | undefined;
  try {
    const endpoints = process.env.RABBITMQ_URLS?.split(",").filter(Boolean) ?? [
      host.url,
    ];
    const url = new URL(endpoints[host.endpointIndex++ % endpoints.length]!);
    url.searchParams.set("heartbeat", "5");
    connection = await amqp.connect(url.toString(), { timeout: 3000 });
    if (await host.abandon(generation, connection)) return;
    connection.on("error", () => undefined);
    connection.on("blocked", () => host.setConnected(false));
    connection.on("unblocked", () => {
      if (!host.stopped && generation === host.generation)
        host.setConnected(true);
    });
    connection.on("close", () => {
      if (generation === host.generation) host.scheduleReconnect();
    });
    const channel = await connection.createConfirmChannel();
    if (await host.abandon(generation, connection)) return;
    channel.on("error", () => undefined);
    channel.on("close", () => {
      if (generation !== host.generation || host.stopped) return;
      host.setConnected(false);
      void connection?.close().catch(() => undefined);
    });
    await assertTopology(channel, host.names(), true, connection);
    if (await host.abandon(generation, connection)) return;
    await channel.prefetch(1);
    try {
      await host.extension?.attach(connection, host.worker);
    } catch (error) {
      host.report(
        `AI channel unavailable. Event processing continues. ${formatError(error)}`,
      );
    }
    if (await host.abandon(generation, connection)) return;
    let consumerTag: string | undefined;
    if (host.worker) {
      const result = await channel.consume(
        host.names().queue,
        (message) => {
          if (!message) {
            host.setConnected(false);
            void connection?.close().catch(() => undefined);
            return;
          }
          const job = host.handle(channel, message).catch(async (error) => {
            host.report(`Consumer failed. ${formatError(error)}`);
            // Delayed dead-letter — never hot-requeue the same delivery.
            await new Promise<void>((resolve) => setTimeout(resolve, 1500));
            try {
              channel.nack(message, false, false);
            } catch (nackError) {
              host.report(`Consumer nack failed. ${formatError(nackError)}`);
            }
          });
          host.inFlight.add(job);
          void job.finally(() => host.inFlight.delete(job));
        },
        { noAck: false },
      );
      if (await host.abandon(generation, connection)) return;
      consumerTag = result.consumerTag;
    }
    host.setConnected(true);
    host.assign(connection, channel, consumerTag);
  } catch (error) {
    await connection?.close().catch(() => undefined);
    if (generation !== host.generation || host.stopped) return;
    host.setConnected(false);
    throw error;
  }
};
