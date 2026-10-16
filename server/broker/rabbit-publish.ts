import { randomUUID } from "node:crypto";
import type { ConfirmChannel, ConsumeMessage, Options } from "amqplib";

export const confirmPublish = (
  channel: ConfirmChannel,
  exchange: string,
  key: string,
  body: Buffer,
  options: Options.Publish,
  restore: () => Promise<void>,
  dropConnection: () => void,
) => {
  const messageId = options.messageId ?? randomUUID();
  return new Promise<void>((resolve, reject) => {
    let unroutable = false;
    const onReturn = (message: ConsumeMessage) => {
      if (message.properties.messageId === messageId) unroutable = true;
    };
    const timer = setTimeout(() => {
      channel.removeListener("return", onReturn);
      reject(new Error("Publisher confirm timed out"));
      dropConnection();
    }, 4000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      channel.removeListener("return", onReturn);
      if (error) {
        reject(error);
        return;
      }
      if (!unroutable) {
        resolve();
        return;
      }
      void restore().finally(() => {
        reject(new Error(`Unroutable message ${messageId}`));
      });
    };
    channel.on("return", onReturn);
    try {
      channel.publish(
        exchange,
        key,
        body,
        {
          persistent: true,
          contentType: "application/json",
          ...options,
          mandatory: true,
          messageId,
        },
        (error) => finish(error ?? undefined),
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error("publish failed"));
    }
  });
};
