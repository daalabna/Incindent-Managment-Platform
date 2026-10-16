import amqp from "amqplib";

const identifier = /^[A-Za-z0-9_]+$/;

export const rabbitNamespaceResources = (namespace: string) => {
  if (!identifier.test(namespace)) throw new Error("Unsafe namespace");
  return {
    queues: [
      ...["process", "retry", "dead"].flatMap((kind) => [
        `${namespace}.events.${kind}`,
        `${namespace}.events.${kind}.v2`,
      ]),
      `${namespace}.ai.analysis.v1`,
    ],
    exchanges: [
      `${namespace}.events.exchange`,
      `${namespace}.events.exchange.dead`,
    ],
  };
};

const absent = async (
  connection: Awaited<ReturnType<typeof amqp.connect>>,
  name: string,
  kind: "queue" | "exchange",
) => {
  const channel = await connection.createChannel();
  channel.on("error", () => undefined);
  try {
    if (kind === "queue") await channel.checkQueue(name);
    else await channel.checkExchange(name);
    throw new Error(`Test ${kind} remains: ${name}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Test "))
      throw error;
  } finally {
    await channel.close().catch(() => undefined);
  }
};

export const deleteRabbitNamespace = async (url: string, namespace: string) => {
  const names = rabbitNamespaceResources(namespace);
  const connection = await amqp.connect(url);
  try {
    for (const queue of names.queues) {
      const channel = await connection.createChannel();
      channel.on("error", () => undefined);
      try {
        await channel.deleteQueue(queue);
      } catch {
        /* Legacy and current names are both removed. */
      } finally {
        await channel.close().catch(() => undefined);
      }
    }
    for (const exchange of names.exchanges) {
      const channel = await connection.createChannel();
      channel.on("error", () => undefined);
      try {
        await channel.deleteExchange(exchange);
      } catch {
        /* Already removed. */
      } finally {
        await channel.close().catch(() => undefined);
      }
    }
    for (const queue of names.queues) await absent(connection, queue, "queue");
    for (const exchange of names.exchanges)
      await absent(connection, exchange, "exchange");
  } finally {
    await connection.close();
  }
};
