import { expect, it, vi } from "vitest";
import type { ConsumeMessage } from "amqplib";
import { RabbitPipeline } from "../../server/broker/rabbit";
import type { PostgresStore } from "../../server/db/postgres";

const connect = vi.hoisted(() => vi.fn());
vi.mock("amqplib", () => ({ default: { connect } }));

const pipeline = () => {
  return new RabbitPipeline(
    "amqp://localhost",
    "unit",
    {
      pool: {
        query: async () => ({ rows: [{ generation: 0, trace_context: null }] }),
      },
    } as unknown as PostgresStore,
    async () => undefined,
    false,
    () => undefined,
  );
};

it("discards a connection that finishes after close", async () => {
  let release: (connection: {
    close: () => Promise<void>;
    closed: boolean;
  }) => void = () => undefined;
  connect.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const rabbit = pipeline();
  const starting = rabbit.start();
  await Promise.resolve();
  const closing = rabbit.close();
  let closed = false;
  release({
    closed: false,
    async close() {
      closed = true;
    },
  });
  await Promise.all([starting, closing]);
  expect(rabbit.connected).toBe(false);
  expect(closed).toBe(true);
});

it("treats an unroutable publisher confirm as a failure", async () => {
  const returns = new Set<(message: ConsumeMessage) => void>();
  const channel = {
    on(event: string, handler: (message: ConsumeMessage) => void) {
      if (event === "return") returns.add(handler);
      return channel;
    },
    removeListener(event: string, handler: (message: ConsumeMessage) => void) {
      if (event === "return") returns.delete(handler);
      return channel;
    },
    async assertExchange() {},
    async assertQueue() {},
    async bindQueue() {},
    async prefetch() {},
    publish(
      _exchange: string,
      _key: string,
      _body: Buffer,
      options: { messageId?: string },
      callback: (error: Error | null) => void,
    ) {
      queueMicrotask(() => {
        for (const handler of returns)
          handler({
            properties: { messageId: options.messageId },
          } as ConsumeMessage);
        callback(null);
      });
      return true;
    },
  };
  const connection = {
    on() {
      return connection;
    },
    async createConfirmChannel() {
      return channel;
    },
    async createChannel() {
      return {
        on() {
          return this;
        },
        async close() {},
        async checkQueue() {
          throw new Error("missing");
        },
      };
    },
    async close() {},
  };
  connect.mockResolvedValue(connection);
  const rabbit = pipeline();
  await rabbit.start();
  await expect(rabbit.publish("event-1")).rejects.toThrow(
    /Unroutable message event-1/,
  );
  await rabbit.close();
});
