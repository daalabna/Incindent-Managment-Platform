import type { ChannelModel, ConfirmChannel } from "amqplib";
import { z } from "zod";
import { confirmPublish } from "../broker/rabbit-publish";

// Separate channel on the shared connection. Closing this channel must not close event processing.
export class AiQueue {
  private channel?: ConfirmChannel;
  private consumerTag?: string;
  private connection?: ChannelModel;
  private worker = false;
  private closing = false;
  private failures = 0;
  private openedAt = 0;
  private reopenTimer?: ReturnType<typeof setTimeout>;
  private work = new Set<Promise<void>>();
  readonly name: string;
  constructor(
    namespace: string,
    private process: (id: string) => Promise<void>,
    private report: (text: string) => void,
  ) {
    this.name = `${namespace}.ai.analysis.v1`;
  }
  private topology = async (channel: ConfirmChannel) => {
    await channel.assertQueue(this.name, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-overflow": "reject-publish",
        "x-max-length": 1000,
        "x-message-ttl": 300000,
        "x-delivery-limit": 5,
      },
    });
  };
  private open = async () => {
    const connection = this.connection;
    if (!connection || this.closing) return;
    const channel = await connection.createConfirmChannel();
    this.openedAt = Date.now();
    channel.on("error", () => undefined);
    channel.on("close", () => {
      if (this.channel === channel) {
        this.channel = undefined;
        this.consumerTag = undefined;
      }
      if (this.closing) return;
      if (Date.now() - this.openedAt >= 30_000) this.failures = 0;
      else this.failures += 1;
      this.report("AI channel closed. Event processing continues.");
      this.schedule();
    });
    await this.topology(channel);
    if (this.closing) {
      await channel.close().catch(() => undefined);
      return;
    }
    await channel.prefetch(1);
    this.channel = channel;
    if (!this.worker) return;
    const consumer = await channel.consume(this.name, (message) => {
      if (!message) {
        this.report("AI consumer cancelled. Event processing continues.");
        void channel.close().catch(() => undefined);
        return;
      }
      const job = (async () => {
        let id: string;
        try {
          id = z
            .object({ analysisId: z.string().uuid() })
            .parse(JSON.parse(message.content.toString())).analysisId;
        } catch {
          this.report("AI message rejected: invalid envelope");
          channel.nack(message, false, false);
          return;
        }
        try {
          await this.process(id);
          channel.ack(message);
        } catch (error) {
          this.report(
            `AI job deferred; durable recovery will retry. ${error instanceof Error ? error.message : "unknown"}`,
          );
          channel.nack(message, false, false);
        }
      })().catch((error) => {
        this.report(
          `AI consumer handler failed. ${error instanceof Error ? error.message : "unknown"}`,
        );
      });
      this.work.add(job);
      void job.finally(() => this.work.delete(job));
    });
    this.consumerTag = consumer.consumerTag;
  };
  private schedule = () => {
    if (this.closing || this.reopenTimer) return;
    const delay = this.failures <= 5 ? 1000 : 60_000;
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = undefined;
      void this.open().catch((error) => {
        this.report(
          `AI channel reopen failed. ${error instanceof Error ? error.message : "unknown error"}`,
        );
        this.schedule();
      });
    }, delay);
  };
  attach = async (connection: ChannelModel, worker: boolean) => {
    this.connection = connection;
    this.worker = worker;
    this.closing = false;
    this.failures = 0;
    clearTimeout(this.reopenTimer);
    this.reopenTimer = undefined;
    try {
      await this.open();
    } catch (error) {
      this.report(
        `AI channel open failed. ${error instanceof Error ? error.message : "unknown error"}`,
      );
      this.schedule();
    }
  };
  publish = async (id: string) => {
    const channel = this.channel;
    if (!channel) throw new Error("AI queue unavailable");
    await confirmPublish(
      channel,
      "",
      this.name,
      Buffer.from(JSON.stringify({ analysisId: id })),
      { messageId: id },
      () => this.topology(channel),
      () => {
        void channel.close().catch(() => undefined);
      },
    );
  };
  health = async () => {
    const channel = this.channel;
    if (!channel)
      return {
        ready: false,
        connected: false,
        consumers: 0,
        queued: null as number | null,
      };
    try {
      const queue = await channel.checkQueue(this.name);
      const consumers = Number(queue.consumerCount ?? 0);
      return {
        ready: consumers > 0,
        connected: true,
        consumers,
        queued: queue.messageCount,
      };
    } catch {
      return { ready: false, connected: false, consumers: 0, queued: null };
    }
  };
  close = async () => {
    this.closing = true;
    clearTimeout(this.reopenTimer);
    this.reopenTimer = undefined;
    const channel = this.channel;
    if (this.consumerTag && channel)
      await channel.cancel(this.consumerTag).catch(() => undefined);
    await Promise.allSettled([...this.work]);
    this.channel = undefined;
    this.consumerTag = undefined;
    await channel?.close().catch(() => undefined);
  };
}
