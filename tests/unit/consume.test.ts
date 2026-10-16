import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { expect, it } from "vitest";
import { processDelivery } from "../../server/broker/rabbit-consume";
import { DomainError } from "../../server/domain/errors";
import type { PostgresStore } from "../../server/db/postgres";

const message = {
  content: Buffer.from(JSON.stringify({ eventId: "evt-1" })),
  properties: { headers: {}, messageId: "evt-1" },
} as ConsumeMessage;

const delivery = (
  failure: Error,
  confirm: (exchange: string) => Promise<void>,
  status: () => Promise<void> = async () => undefined,
  source: ConsumeMessage = message,
) => {
  const acks: boolean[] = [];
  const nacks: boolean[] = [];
  const queries: string[] = [];
  const published: Array<{ exchange: string; statusOnly?: unknown }> = [];
  const channel = {
    ack: () => acks.push(true),
    nack: (_message: ConsumeMessage, _allUpTo: boolean, requeue: boolean) =>
      nacks.push(requeue),
  } as unknown as ConfirmChannel;
  const store = {
    processEvent: async () => {
      throw failure;
    },
    pool: {
      query: async (text: string) => {
        queries.push(text);
        await status();
      },
    },
  } as unknown as PostgresStore;
  return {
    acks,
    nacks,
    queries,
    published,
    run: () =>
      processDelivery(channel, source, {
        store,
        deadExchange: "dead.exchange",
        retryQueue: "retry.queue",
        report: () => undefined,
        onChange: async () => undefined,
        confirm: async (_channel, exchange, _key, _body, options) => {
          published.push({
            exchange,
            statusOnly: options.headers?.["x-status-only"],
          });
          await confirm(exchange);
        },
        requeueDelayMs: 0,
      }),
  };
};

it("parks a failed dead-letter publish on the retry queue without marking it failed", async () => {
  const exchanges: string[] = [];
  const attempt = delivery(
    new DomainError("terminal failure"),
    async (exchange) => {
      exchanges.push(exchange);
      if (exchange === "dead.exchange")
        throw new Error("dead exchange unavailable");
    },
  );
  await attempt.run();
  expect(exchanges).toEqual(["dead.exchange", ""]);
  expect(attempt.acks).toEqual([true]);
  expect(attempt.nacks).toEqual([]);
  expect(attempt.queries).toEqual([]);
});

it("dead-letters without requeue when both dead-letter and retry publishes fail", async () => {
  const attempt = delivery(new DomainError("terminal failure"), async () => {
    throw new Error("broker unavailable");
  });
  await attempt.run();
  expect(attempt.acks).toEqual([]);
  expect(attempt.nacks).toEqual([false]);
  expect(attempt.queries).toEqual([]);
});

it("keeps a dead-lettered message when saving its failed status throws", async () => {
  const attempt = delivery(
    new DomainError("terminal failure"),
    async () => undefined,
    async () => {
      throw new Error("database unavailable");
    },
  );
  await attempt.run();
  expect(attempt.queries).toHaveLength(1);
  expect(attempt.published).toEqual([
    { exchange: "dead.exchange", statusOnly: undefined },
    { exchange: "", statusOnly: 1 },
  ]);
  expect(attempt.acks).toEqual([true]);
  expect(attempt.nacks).toEqual([]);
});

it("does not publish another dead-letter copy when a status-only retry fails again", async () => {
  const retry = {
    content: message.content,
    properties: {
      headers: { "x-status-only": 1, "x-retry-count": 3 },
      messageId: "evt-1",
    },
  } as unknown as ConsumeMessage;
  const attempt = delivery(
    new DomainError("must not be processed again"),
    async (exchange) => {
      if (exchange === "dead.exchange") throw new Error("republished to DLQ");
    },
    async () => {
      throw new Error("database unavailable");
    },
    retry,
  );
  await attempt.run();
  expect(attempt.published).toEqual([{ exchange: "", statusOnly: 1 }]);
  expect(attempt.acks).toEqual([true]);
  expect(attempt.nacks).toEqual([]);
});

it("dead-letters a retryable failure when the retry queue is unavailable", async () => {
  const exchanges: string[] = [];
  const attempt = delivery(
    new Error("temporary DB failure"),
    async (exchange) => {
      exchanges.push(exchange);
      throw new Error("retry queue unavailable");
    },
  );
  await attempt.run();
  expect(exchanges).toEqual(["", "dead.exchange"]);
  expect(attempt.acks).toEqual([]);
  expect(attempt.nacks).toEqual([false]);
});

it("parks DLQ publish failure as status-only after durable terminalDelivery succeeds", async () => {
  const published: Array<{ exchange: string; statusOnly?: unknown }> = [];
  const channel = {
    ack: () => undefined,
    nack: () => undefined,
  } as unknown as ConfirmChannel;
  const source = {
    content: Buffer.from(JSON.stringify({ eventId: "evt-1" })),
    properties: { headers: { "x-generation": 0 }, messageId: "evt-1" },
  } as unknown as ConsumeMessage;
  await processDelivery(channel, source, {
    store: {
      processDelivery: async () => {
        throw new DomainError("terminal failure");
      },
      terminalDelivery: async () => undefined,
      pool: { query: async () => undefined },
    } as unknown as PostgresStore,
    deadExchange: "dead.exchange",
    retryQueue: "retry.queue",
    report: () => undefined,
    onChange: async () => undefined,
    confirm: async (_channel, exchange, _key, _body, options) => {
      published.push({
        exchange,
        statusOnly: options.headers?.["x-status-only"],
      });
      if (exchange === "dead.exchange")
        throw new Error("dead exchange unavailable");
    },
    requeueDelayMs: 0,
    durableBudget: true,
  });
  expect(published).toEqual([
    { exchange: "dead.exchange", statusOnly: undefined },
    { exchange: "", statusOnly: 1 },
  ]);
});

it("terminals invalid durable x-generation via DB generation and DLQ", async () => {
  const published: string[] = [];
  const acks: boolean[] = [];
  let terminalGen: number | null | undefined;
  const channel = {
    ack: () => acks.push(true),
    nack: () => undefined,
  } as unknown as ConfirmChannel;
  const source = {
    content: Buffer.from(JSON.stringify({ eventId: "evt-bad" })),
    properties: { headers: { "x-generation": "nope" }, messageId: "evt-bad" },
  } as unknown as ConsumeMessage;
  await processDelivery(channel, source, {
    store: {
      processDelivery: async () => {
        throw new Error("must not process");
      },
      terminalDelivery: async (_id: string, generation: number | null) => {
        terminalGen = generation;
      },
      pool: { query: async () => undefined },
    } as unknown as PostgresStore,
    deadExchange: "dead.exchange",
    retryQueue: "retry.queue",
    report: () => undefined,
    onChange: async () => undefined,
    confirm: async (_channel, exchange) => {
      published.push(exchange);
    },
    requeueDelayMs: 0,
    durableBudget: true,
  });
  expect(published).toEqual(["dead.exchange"]);
  expect(acks).toEqual([true]);
  expect(terminalGen).toBeNull();
});

it("terminals missing durable x-generation via DB generation and DLQ", async () => {
  const published: string[] = [];
  const acks: boolean[] = [];
  let terminalGen: number | null | undefined;
  const channel = {
    ack: () => acks.push(true),
    nack: () => undefined,
  } as unknown as ConfirmChannel;
  const source = {
    content: Buffer.from(JSON.stringify({ eventId: "evt-missing" })),
    properties: { headers: {}, messageId: "evt-missing" },
  } as unknown as ConsumeMessage;
  await processDelivery(channel, source, {
    store: {
      processDelivery: async () => {
        throw new Error("must not process");
      },
      terminalDelivery: async (_id: string, generation: number | null) => {
        terminalGen = generation;
      },
      pool: { query: async () => undefined },
    } as unknown as PostgresStore,
    deadExchange: "dead.exchange",
    retryQueue: "retry.queue",
    report: () => undefined,
    onChange: async () => undefined,
    confirm: async (_channel, exchange) => {
      published.push(exchange);
    },
    requeueDelayMs: 0,
    durableBudget: true,
  });
  expect(published).toEqual(["dead.exchange"]);
  expect(acks).toEqual([true]);
  expect(terminalGen).toBeNull();
});

it("acks already-terminal durable redelivery without republishing DLQ", async () => {
  const published: string[] = [];
  const acks: boolean[] = [];
  const channel = {
    ack: () => acks.push(true),
    nack: () => undefined,
  } as unknown as ConfirmChannel;
  const source = {
    content: Buffer.from(JSON.stringify({ eventId: "evt-1" })),
    properties: { headers: { "x-generation": 0 }, messageId: "evt-1" },
  } as unknown as ConsumeMessage;
  await processDelivery(channel, source, {
    store: {
      processDelivery: async () => ({ terminal: true as const }),
      terminalDelivery: async () => {
        throw new Error("must not terminalize");
      },
      pool: { query: async () => undefined },
    } as unknown as PostgresStore,
    deadExchange: "dead.exchange",
    retryQueue: "retry.queue",
    report: () => undefined,
    onChange: async () => undefined,
    confirm: async (_channel, exchange) => {
      published.push(exchange);
    },
    requeueDelayMs: 0,
    durableBudget: true,
  });
  expect(published).toEqual([]);
  expect(acks).toEqual([true]);
});

it("acks bare status-only missing x-generation without terminalizing", async () => {
  const acks: boolean[] = [];
  let terminals = 0;
  const channel = {
    ack: () => acks.push(true),
    nack: () => undefined,
  } as unknown as ConfirmChannel;
  const source = {
    content: Buffer.from(JSON.stringify({ eventId: "evt-1" })),
    properties: {
      headers: { "x-status-only": 1, "x-retry-count": 4 },
      messageId: "evt-1",
    },
  } as unknown as ConsumeMessage;
  await processDelivery(channel, source, {
    store: {
      processDelivery: async () => {
        throw new Error("must not process");
      },
      terminalDelivery: async () => {
        terminals += 1;
      },
      pool: { query: async () => undefined },
    } as unknown as PostgresStore,
    deadExchange: "dead.exchange",
    retryQueue: "retry.queue",
    report: () => undefined,
    onChange: async () => undefined,
    confirm: async () => undefined,
    requeueDelayMs: 0,
    durableBudget: true,
  });
  expect(acks).toEqual([true]);
  expect(terminals).toBe(0);
});

it("terminals status-only missing x-generation when marked invalid-generation retry", async () => {
  const acks: boolean[] = [];
  let terminalGen: number | null | undefined;
  const channel = {
    ack: () => acks.push(true),
    nack: () => undefined,
  } as unknown as ConfirmChannel;
  const source = {
    content: Buffer.from(JSON.stringify({ eventId: "evt-1" })),
    properties: {
      headers: {
        "x-status-only": 1,
        "x-invalid-generation": 1,
        "x-retry-count": 4,
      },
      messageId: "evt-1",
    },
  } as unknown as ConsumeMessage;
  await processDelivery(channel, source, {
    store: {
      terminalDelivery: async (_id: string, generation: number | null) => {
        terminalGen = generation;
      },
      pool: { query: async () => undefined },
    } as unknown as PostgresStore,
    deadExchange: "dead.exchange",
    retryQueue: "retry.queue",
    report: () => undefined,
    onChange: async () => undefined,
    confirm: async () => undefined,
    requeueDelayMs: 0,
    durableBudget: true,
  });
  expect(acks).toEqual([true]);
  expect(terminalGen).toBeNull();
});

it("terminals empty-string durable x-generation via DB generation and DLQ", async () => {
  const published: string[] = [];
  const acks: boolean[] = [];
  let terminalGen: number | null | undefined;
  const channel = {
    ack: () => acks.push(true),
    nack: () => undefined,
  } as unknown as ConfirmChannel;
  const source = {
    content: Buffer.from(JSON.stringify({ eventId: "evt-empty" })),
    properties: {
      headers: { "x-generation": "" },
      messageId: "evt-empty",
    },
  } as unknown as ConsumeMessage;
  await processDelivery(channel, source, {
    store: {
      processDelivery: async () => {
        throw new Error("must not process");
      },
      terminalDelivery: async (_id: string, generation: number | null) => {
        terminalGen = generation;
      },
      pool: { query: async () => undefined },
    } as unknown as PostgresStore,
    deadExchange: "dead.exchange",
    retryQueue: "retry.queue",
    report: () => undefined,
    onChange: async () => undefined,
    confirm: async (_channel, exchange) => {
      published.push(exchange);
    },
    requeueDelayMs: 0,
    durableBudget: true,
  });
  expect(published).toEqual(["dead.exchange"]);
  expect(acks).toEqual([true]);
  expect(terminalGen).toBeNull();
});

it("terminals durable event before DLQ when retry park fails", async () => {
  const published: string[] = [];
  const acks: boolean[] = [];
  const terminals: string[] = [];
  const channel = {
    ack: () => acks.push(true),
    nack: () => undefined,
  } as unknown as ConfirmChannel;
  const source = {
    content: Buffer.from(JSON.stringify({ eventId: "evt-park" })),
    properties: { headers: { "x-generation": 0 }, messageId: "evt-park" },
  } as unknown as ConsumeMessage;
  await processDelivery(channel, source, {
    store: {
      processDelivery: async () => {
        throw new Error("temporary failure");
      },
      terminalDelivery: async (
        _id: string,
        _generation: number | null,
        reason: string,
      ) => {
        terminals.push(reason);
      },
      pool: { query: async () => undefined },
    } as unknown as PostgresStore,
    deadExchange: "dead.exchange",
    retryQueue: "retry.queue",
    report: () => undefined,
    onChange: async () => undefined,
    confirm: async (_channel, exchange) => {
      published.push(exchange);
      if (exchange === "") throw new Error("retry queue unavailable");
    },
    requeueDelayMs: 0,
    durableBudget: true,
  });
  expect(terminals.some((reason) => /Retry park failed/i.test(reason))).toBe(
    true,
  );
  expect(published).toEqual(["", "dead.exchange"]);
  expect(acks).toEqual([true]);
});

it("does not ack app DLQ when retry park fails and terminalDelivery throws", async () => {
  const published: string[] = [];
  const acks: boolean[] = [];
  const nacks: boolean[] = [];
  const channel = {
    ack: () => acks.push(true),
    nack: (_message: ConsumeMessage, _allUpTo: boolean, requeue: boolean) =>
      nacks.push(requeue),
  } as unknown as ConfirmChannel;
  const source = {
    content: Buffer.from(JSON.stringify({ eventId: "evt-limbo" })),
    properties: { headers: { "x-generation": 0 }, messageId: "evt-limbo" },
  } as unknown as ConsumeMessage;
  await processDelivery(channel, source, {
    store: {
      processDelivery: async () => {
        throw new Error("temporary failure");
      },
      terminalDelivery: async () => {
        throw new Error("database unavailable");
      },
      pool: { query: async () => undefined },
    } as unknown as PostgresStore,
    deadExchange: "dead.exchange",
    retryQueue: "retry.queue",
    report: () => undefined,
    onChange: async () => undefined,
    confirm: async (_channel, exchange) => {
      published.push(exchange);
      if (exchange === "") throw new Error("retry queue unavailable");
    },
    requeueDelayMs: 0,
    durableBudget: true,
  });
  expect(published).toEqual([""]);
  expect(acks).toEqual([]);
  expect(nacks).toEqual([false]);
});

it("parks a status-only retry when durable terminalDelivery fails instead of hot-requeue", async () => {
  const acks: boolean[] = [];
  const nacks: boolean[] = [];
  const published: Array<{ exchange: string; statusOnly?: unknown }> = [];
  const channel = {
    ack: () => acks.push(true),
    nack: (_message: ConsumeMessage, _allUpTo: boolean, requeue: boolean) =>
      nacks.push(requeue),
  } as unknown as ConfirmChannel;
  const source = {
    content: Buffer.from(JSON.stringify({ eventId: "evt-1" })),
    properties: { headers: { "x-generation": 0 }, messageId: "evt-1" },
  } as unknown as ConsumeMessage;
  await processDelivery(channel, source, {
    store: {
      processDelivery: async () => {
        throw new DomainError("terminal failure");
      },
      terminalDelivery: async () => {
        throw new Error("database unavailable");
      },
      pool: { query: async () => undefined },
    } as unknown as PostgresStore,
    deadExchange: "dead.exchange",
    retryQueue: "retry.queue",
    report: () => undefined,
    onChange: async () => undefined,
    confirm: async (_channel, exchange, _key, _body, options) => {
      published.push({
        exchange,
        statusOnly: options.headers?.["x-status-only"],
      });
    },
    requeueDelayMs: 0,
    durableBudget: true,
  });
  expect(published).toEqual([{ exchange: "", statusOnly: 1 }]);
  expect(acks).toEqual([true]);
  expect(nacks).toEqual([]);
});
