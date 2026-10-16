import type { Channel, ConfirmChannel, GetMessage } from "amqplib";

export type RabbitNames = {
  exchange: string;
  deadExchange: string;
  queue: string;
  retryQueue: string;
  deadQueue: string;
};
export type ChannelOpener = { createChannel: () => Promise<Channel> };

export const assertTopology = async (
  channel: ConfirmChannel,
  names: RabbitNames,
  quorum = true,
  openChannel?: ChannelOpener,
) => {
  const replicated = quorum
    ? {
        "x-queue-type": "quorum",
        "x-overflow": "reject-publish",
        "x-delivery-limit": -1,
      }
    : {};
  const transfer = quorum ? { "x-dead-letter-strategy": "at-least-once" } : {};
  await channel.assertExchange(names.exchange, "topic", { durable: true });
  await channel.assertExchange(names.deadExchange, "direct", { durable: true });
  await channel.assertQueue(names.deadQueue, {
    durable: true,
    arguments: replicated,
  });
  await channel.bindQueue(names.deadQueue, names.deadExchange, "dead");
  await channel.assertQueue(names.queue, {
    durable: true,
    arguments: {
      ...replicated,
      ...transfer,
      "x-single-active-consumer": true,
      "x-dead-letter-exchange": names.deadExchange,
      "x-dead-letter-routing-key": "dead",
    },
  });
  await channel.bindQueue(names.queue, names.exchange, "event.received");
  await channel.assertQueue(names.retryQueue, {
    durable: true,
    arguments: {
      ...replicated,
      ...transfer,
      "x-message-ttl": 1500,
      "x-dead-letter-exchange": names.exchange,
      "x-dead-letter-routing-key": "event.received",
    },
  });
  if (!quorum) return;
  if (!openChannel)
    throw new Error("Classic queue migration needs the RabbitMQ connection");
  await drainLegacyQueues(openChannel, channel, names);
};

const queueExists = async (broker: ChannelOpener, name: string) => {
  const probe = await broker.createChannel();
  probe.on("error", () => undefined);
  try {
    await probe.checkQueue(name);
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
};

const publishToQueue = (
  channel: ConfirmChannel,
  queue: string,
  message: GetMessage,
) =>
  new Promise<void>((resolve, reject) => {
    let confirmed = false;
    let drained = true;
    const finish = () => {
      if (confirmed && drained) resolve();
    };
    const accepted = channel.publish(
      "",
      queue,
      message.content,
      {
        persistent: true,
        messageId: message.properties.messageId,
        headers: message.properties.headers,
        contentType: message.properties.contentType,
      },
      (error) => {
        if (error) reject(error);
        else {
          confirmed = true;
          finish();
        }
      },
    );
    if (!accepted) {
      drained = false;
      channel.once("drain", () => {
        drained = true;
        finish();
      });
    }
  });

export const drainLegacyQueues = async (
  openChannel: ChannelOpener,
  channel: ConfirmChannel,
  names: RabbitNames,
) => {
  if (!names.queue.endsWith(".v2")) return;
  const moves: Array<{
    from: string;
    to: string;
    exchange?: string;
    key?: string;
  }> = [
    {
      from: names.queue.slice(0, -3),
      to: names.queue,
      exchange: names.exchange,
      key: "event.received",
    },
    { from: names.retryQueue.slice(0, -3), to: names.retryQueue },
    {
      from: names.deadQueue.slice(0, -3),
      to: names.deadQueue,
      exchange: names.deadExchange,
      key: "dead",
    },
  ];
  for (const move of moves) {
    if (!(await queueExists(openChannel, move.from))) continue;
    const source = await openChannel.createChannel();
    source.on("error", () => undefined);
    try {
      for (;;) {
        const message = await source.get(move.from, { noAck: false });
        if (!message) break;
        await publishToQueue(channel, move.to, message);
        source.ack(message);
      }
      if (move.exchange && move.key)
        await source
          .unbindQueue(move.from, move.exchange, move.key)
          .catch(() => undefined);
    } finally {
      await source.close().catch(() => undefined);
    }
  }
};
