import { expect, it } from "vitest";
import {
  drainLegacyQueues,
  type RabbitNames,
} from "../../server/broker/rabbit-topology";

it("copies classic queue messages into v2 through an explicit channel opener", async () => {
  const waiting = new Map<string, Buffer[]>([
    ["ns.events.process", [Buffer.from('{"eventId":"a"}')]],
  ]);
  const published: string[] = [];
  const unbound: string[] = [];
  const deleted: string[] = [];
  const probe = () => ({
    on: () => undefined,
    close: async () => undefined,
    deleteQueue: async (queue: string) => {
      deleted.push(queue);
    },
    checkQueue: async (name: string) => {
      if (!waiting.has(name)) throw new Error("missing");
      return { messageCount: waiting.get(name)?.length ?? 0 };
    },
    get: async (queue: string) => {
      const content = waiting.get(queue)?.shift();
      return content
        ? {
            content,
            properties: {
              messageId: "m",
              headers: {},
              contentType: "application/json",
            },
            fields: {},
          }
        : false;
    },
    ack: () => undefined,
    unbindQueue: async (queue: string) => {
      unbound.push(queue);
    },
  });
  const confirm = {
    publish: (
      _exchange: string,
      queue: string,
      content: Buffer,
      _options: unknown,
      done: (error?: Error) => void,
    ) => {
      published.push(`${queue}:${content.toString()}`);
      done();
      return true;
    },
    once: () => undefined,
  };
  const names: RabbitNames = {
    exchange: "ns.events.exchange",
    deadExchange: "ns.events.exchange.dead",
    queue: "ns.events.process.v2",
    retryQueue: "ns.events.retry.v2",
    deadQueue: "ns.events.dead.v2",
  };
  await drainLegacyQueues(
    { createChannel: async () => probe() as never },
    confirm as never,
    names,
  );
  expect(published).toEqual(['ns.events.process.v2:{"eventId":"a"}']);
  expect(unbound).toEqual(["ns.events.process"]);
  expect(deleted).toEqual([]);
});
