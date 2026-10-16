import {
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from "amqplib";
import { formatError } from "../domain/errors";
import type { PostgresStore } from "../db/postgres";
import { processDelivery } from "./rabbit-consume";
import { confirmPublish } from "./rabbit-publish";
import { assertTopology, type RabbitNames } from "./rabbit-topology";
import { traced, traceHeaders } from "../observability/telemetry";
import { reportRabbitHealth } from "./rabbit-health";
import { connectRabbit } from "./rabbit-connect";

export class RabbitPipeline {
  connection?: ChannelModel;
  channel?: ConfirmChannel;
  connected = false;
  private stopped = false;
  private generation = 0;
  private attempt?: Promise<void>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private consumerTag?: string;
  private inFlight = new Set<Promise<void>>();
  private restoring?: Promise<void>;
  private endpointIndex = 0;
  readonly exchange: string;
  readonly deadExchange: string;
  readonly queue: string;
  readonly retryQueue: string;
  readonly deadQueue: string;
  constructor(
    private url: string,
    namespace: string,
    private store: PostgresStore,
    private onChange: (notice: { incidentId: string | null }) => Promise<void>,
    private worker: boolean,
    private report: (message: string) => void,
    private extension?: {
      attach(connection: ChannelModel, worker: boolean): Promise<void>;
      close(): Promise<void>;
      health?: () => Promise<{
        ready: boolean;
        connected: boolean;
        consumers: number;
        queued: number | null;
      }>;
    },
  ) {
    this.exchange = `${namespace}.events.exchange`;
    this.deadExchange = `${namespace}.events.exchange.dead`;
    this.queue = `${namespace}.events.process.v2`;
    this.retryQueue = `${namespace}.events.retry.v2`;
    this.deadQueue = `${namespace}.events.dead.v2`;
  }
  private names = (): RabbitNames => ({
    exchange: this.exchange,
    deadExchange: this.deadExchange,
    queue: this.queue,
    retryQueue: this.retryQueue,
    deadQueue: this.deadQueue,
  });
  start = async () => {
    this.attempt = this.connect();
    await this.attempt;
  };
  private scheduleReconnect = () => {
    this.connected = false;
    if (this.stopped || this.reconnect) return;
    this.report("RabbitMQ disconnected; reconnecting. Outbox remains durable.");
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      if (this.stopped) return;
      this.attempt = this.connect().catch((error) => {
        if (this.stopped) return;
        this.report(`RabbitMQ reconnect failed. ${formatError(error)}`);
        this.scheduleReconnect();
      });
    }, 1500);
  };
  private connect = () => {
    const pipeline = this;
    return connectRabbit({
      url: pipeline.url,
      worker: pipeline.worker,
      get stopped() {
        return pipeline.stopped;
      },
      get generation() {
        return pipeline.generation;
      },
      set generation(value: number) {
        pipeline.generation = value;
      },
      get endpointIndex() {
        return pipeline.endpointIndex;
      },
      set endpointIndex(value: number) {
        pipeline.endpointIndex = value;
      },
      names: pipeline.names,
      report: pipeline.report,
      handle: pipeline.handle,
      inFlight: pipeline.inFlight,
      abandon: pipeline.abandon,
      scheduleReconnect: pipeline.scheduleReconnect,
      setConnected: (value) => {
        pipeline.connected = value;
      },
      extension: pipeline.extension,
      assign: (connection, channel, consumerTag) => {
        pipeline.connection = connection;
        pipeline.channel = channel;
        pipeline.consumerTag = consumerTag;
      },
    });
  };
  private abandon = async (generation: number, connection: ChannelModel) => {
    if (!this.stopped && generation === this.generation) return false;
    await connection.close().catch(() => undefined);
    this.connected = false;
    if (this.connection === connection) {
      this.connection = undefined;
      this.channel = undefined;
    }
    return true;
  };
  private restoreTopology = async () => {
    const channel = this.channel;
    if (!channel || this.stopped) return;
    const connection = this.connection;
    if (!connection) return;
    this.restoring ??= assertTopology(channel, this.names(), true, connection)
      .then(() => {
        this.report(
          "RabbitMQ topology reasserted after an unroutable publication.",
        );
      })
      .catch((error: unknown) => {
        this.report(`RabbitMQ topology restore failed. ${formatError(error)}`);
      })
      .finally(() => {
        this.restoring = undefined;
      });
    await this.restoring;
  };
  private confirm = (
    channel: ConfirmChannel,
    exchange: string,
    key: string,
    body: Buffer,
    options: Options.Publish,
  ) =>
    confirmPublish(
      channel,
      exchange,
      key,
      body,
      options,
      () => this.restoreTopology(),
      () => {
        void this.connection?.close().catch(() => undefined);
      },
    );
  publish = async (id: string) => {
    if (!this.connected || !this.channel)
      throw new Error("RabbitMQ unavailable");
    const channel = this.channel;
    const row = await this.store.pool.query<{
      generation: number;
      trace_context: Record<string, string> | null;
    }>("SELECT generation,trace_context FROM monitoring_events WHERE id=$1", [
      id,
    ]);
    const generation = row.rows[0]?.generation ?? 0;
    await traced(
      "rabbit.publish",
      () =>
        this.confirm(
          channel,
          this.exchange,
          "event.received",
          Buffer.from(JSON.stringify({ eventId: id })),
          {
            messageId: id,
            headers: {
              ...traceHeaders(),
              "x-generation": generation,
              "x-first-at": Date.now(),
            },
          },
        ),
      row.rows[0]?.trace_context ?? undefined,
    );
  };
  private handle = (channel: ConfirmChannel, message: ConsumeMessage) =>
    traced(
      "rabbit.consume",
      () =>
        processDelivery(channel, message, {
          store: this.store,
          deadExchange: this.deadExchange,
          retryQueue: this.retryQueue,
          report: this.report,
          onChange: this.onChange,
          confirm: this.confirm,
          durableBudget: true,
        }),
      message.properties.headers,
    );
  health = () =>
    reportRabbitHealth(
      this.connected,
      this.channel,
      this.store,
      { main: this.queue, dead: this.deadQueue },
      this.extension,
    );
  close = async () => {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.reconnect);
    await this.attempt?.catch(() => undefined);
    if (this.consumerTag && this.channel)
      await this.channel.cancel(this.consumerTag).catch(() => undefined);
    await this.extension?.close();
    await Promise.allSettled([...this.inFlight]);
    await this.connection?.close().catch(() => undefined);
    this.connected = false;
    this.connection = undefined;
    this.channel = undefined;
  };
}
