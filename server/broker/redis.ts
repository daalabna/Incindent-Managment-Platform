import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

export type ChangeNotice = {
  scopes: Array<"summary" | "activity" | "incident">;
  incidentId?: string | null;
};

type PublishedNotice = ChangeNotice & { origin: string; marker: string };

export class RedisCoordinator {
  client: Redis;
  subscriber: Redis;
  readonly originId = randomUUID();
  readonly channel: string;
  readonly simulationKey: string;
  constructor(url: string, namespace: string) {
    this.client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempts) => Math.min(attempts * 250, 3000),
    });
    this.subscriber = this.client.duplicate();
    this.client.on("error", () => undefined);
    this.subscriber.on("error", () => undefined);
    this.channel = `${namespace}:state.changed`;
    this.simulationKey = `${namespace}:simulation-lock`;
  }
  start = async (onChange: (notice: ChangeNotice) => void) => {
    await Promise.all([this.client.connect(), this.subscriber.connect()]);
    this.subscriber.on("message", (channel, body) => {
      if (channel !== this.channel) return;
      const notice = parseNotice(body);
      if (!notice || notice.origin === this.originId) return;
      onChange(notice);
    });
    await this.subscriber.subscribe(this.channel);
  };
  notify = async (notice: ChangeNotice) => {
    const message: PublishedNotice = {
      ...notice,
      origin: this.originId,
      marker: randomUUID(),
    };
    // The durable mutation is already committed. Polling/reconnect heals a lost invalidation.
    await this.client
      .publish(this.channel, JSON.stringify(message))
      .catch(() => undefined);
    return message.marker;
  };
  acquireSimulation = async () => {
    const token = randomUUID();
    return (await this.client.set(
      this.simulationKey,
      token,
      "PX",
      60000,
      "NX",
    )) === "OK"
      ? token
      : null;
  };
  renewSimulation = async (token: string) =>
    (await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], 60000) else return 0 end",
      1,
      this.simulationKey,
      token,
    )) === 1;
  releaseSimulation = async (token: string) => {
    await this.client
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        this.simulationKey,
        token,
      )
      .catch(() => undefined);
  };
  health = async () =>
    this.client.status === "ready" &&
    this.subscriber.status === "ready" &&
    (await this.client.ping()) === "PONG";
  close = () => {
    this.client.disconnect();
    this.subscriber.disconnect();
  };
}

const parseNotice = (body: string): PublishedNotice | undefined => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return;
    if (!("origin" in parsed) || typeof parsed.origin !== "string") return;
    if (!("marker" in parsed) || typeof parsed.marker !== "string") return;
    if (!("scopes" in parsed) || !Array.isArray(parsed.scopes)) return;
    const scopes = parsed.scopes.filter(
      (scope): scope is PublishedNotice["scopes"][number] =>
        scope === "summary" || scope === "activity" || scope === "incident",
    );
    const incidentId =
      "incidentId" in parsed &&
      (typeof parsed.incidentId === "string" || parsed.incidentId === null)
        ? parsed.incidentId
        : null;
    return { origin: parsed.origin, marker: parsed.marker, scopes, incidentId };
  } catch {
    return;
  }
};
