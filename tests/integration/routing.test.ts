import amqp from "amqplib";
import { expect, it } from "vitest";
import { assertTopology } from "../../server/broker/rabbit-topology";
import { RabbitPipeline } from "../../server/broker/rabbit";
import { createIsolated, withCleanup } from "../support/isolated-infra";
import { event } from "./helpers";

it("leaves the outbox pending when RabbitMQ cannot route, then publishes after restoring the binding", async () => {
  const isolated = await createIsolated();
  const pipeline = new RabbitPipeline(
    isolated.base.rabbitUrl,
    isolated.name,
    isolated.direct,
    async () => undefined,
    false,
    () => undefined,
  );
  await withCleanup(
    async () => {
      await pipeline.start();
      const connection = await amqp.connect(isolated.base.rabbitUrl);
      try {
        const channel = await connection.createChannel();
        await channel.unbindQueue(
          pipeline.queue,
          pipeline.exchange,
          "event.received",
        );
      } finally {
        await connection.close();
      }
      const input = event();
      await isolated.direct.accept(input);
      const failed = await isolated.direct.publishPending((id) =>
        pipeline.publish(id),
      );
      expect(failed.join("\n")).toMatch(/Unroutable/);
      expect((await isolated.direct.stats()).pending).toBe(1);
      expect((await isolated.direct.eventStatus(input.id)).status).toBe(
        "queued",
      );
      const restored = await isolated.direct.publishPending((id) =>
        pipeline.publish(id),
      );
      expect(restored).toEqual([]);
      expect((await isolated.direct.stats()).pending).toBe(0);
      expect((await isolated.direct.eventStatus(input.id)).status).toBe(
        "queued",
      );
      const channel = pipeline.channel;
      if (!channel) throw new Error("RabbitMQ channel is not open");
      expect((await channel.checkQueue(pipeline.queue)).messageCount).toBe(1);
      const queued = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("published message is not in the queue")),
          5000,
        );
        void channel
          .consume(pipeline.queue, (message) => {
            if (!message) return;
            clearTimeout(timer);
            channel.ack(message);
            void channel
              .cancel(message.fields.consumerTag)
              .then(() => resolve(message.content), reject);
          })
          .catch((error: unknown) => {
            clearTimeout(timer);
            reject(error);
          });
      });
      expect(JSON.parse(queued.toString())).toEqual({ eventId: input.id });
    },
    async () => {
      await pipeline.close().catch(() => undefined);
      await isolated.dispose();
    },
  );
});

it("moves a classic queue backlog into the quorum queue and stops the old binding", async () => {
  const isolated = await createIsolated();
  await withCleanup(
    async () => {
      const connection = await amqp.connect(isolated.base.rabbitUrl);
      try {
        const channel = await connection.createConfirmChannel();
        const names = {
          exchange: `${isolated.name}.events.exchange`,
          deadExchange: `${isolated.name}.events.exchange.dead`,
          queue: `${isolated.name}.events.process.v2`,
          retryQueue: `${isolated.name}.events.retry.v2`,
          deadQueue: `${isolated.name}.events.dead.v2`,
        };
        const legacy = names.queue.slice(0, -3);
        await channel.assertExchange(names.exchange, "topic", {
          durable: true,
        });
        await channel.assertQueue(legacy, { durable: true });
        await channel.bindQueue(legacy, names.exchange, "event.received");
        channel.sendToQueue(legacy, Buffer.from("legacy pending"));
        await channel.waitForConfirms();
        await assertTopology(channel, names, true, connection);
        expect((await channel.checkQueue(legacy)).messageCount).toBe(0);
        expect((await channel.checkQueue(names.queue)).messageCount).toBe(1);
        channel.publish(
          names.exchange,
          "event.received",
          Buffer.from("new event"),
        );
        await channel.waitForConfirms();
        expect((await channel.checkQueue(legacy)).messageCount).toBe(0);
        expect((await channel.checkQueue(names.queue)).messageCount).toBe(2);
      } finally {
        await connection.close();
      }
    },
    () => isolated.dispose(),
  );
});
