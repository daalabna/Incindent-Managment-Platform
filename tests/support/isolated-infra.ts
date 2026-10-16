import { Redis } from "ioredis";
import { deleteRabbitNamespace } from "./rabbit-namespace";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApp } from "../../server/http/app";
import { readConfig } from "../../server/config";
import { PostgresStore } from "../../server/db/postgres";
import type { ChangeNotice } from "../../server/broker/redis";
import { DistributedRuntime } from "../../server/runtime/runtime";
import { cleanupResources } from "./cleanup";
import type { AnalysisProvider } from "../../server/ai/provider";

export const createIsolated = async (prefix = "sentinel_test") => {
  const base = readConfig();
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  if (!new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(name))
    throw new Error("Invalid cleanup target");
  const database = new URL(base.databaseUrl);
  database.pathname = `/${name}`;
  const config = {
    ...base,
    databaseUrl: database.toString(),
    namespace: name,
    embeddedWorker: false,
    ai: { enabled: false, model: "test-model", dailyLimit: 50 },
  };
  const admin = new Pool({
    connectionString: base.databaseUrl,
    connectionTimeoutMillis: 3000,
  });
  admin.on("error", () => undefined);
  await admin.query(`CREATE DATABASE "${name}"`);
  const direct = new PostgresStore(config.databaseUrl);
  let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
  let api: DistributedRuntime | undefined;
  let worker: DistributedRuntime | undefined;
  try {
    await direct.migrate();
  } catch (error) {
    await cleanupResources([
      async () => direct.close(),
      async () => {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      },
      async () => admin.end(),
    ]);
    throw error;
  }
  return {
    name,
    base,
    config,
    direct,
    async startApi() {
      const built = await createApp(config);
      app = built.app;
      if (!(built.runtime instanceof DistributedRuntime))
        throw new Error("Expected the distributed runtime");
      api = built.runtime;
      return { app, api };
    },
    async startWorker(
      onChange: (notice: ChangeNotice) => void = () => undefined,
      aiProvider?: AnalysisProvider,
    ) {
      worker = new DistributedRuntime(
        { ...config, embeddedWorker: true },
        onChange,
        () => undefined,
        aiProvider,
      );
      await worker.start();
      return worker;
    },
    async dispose() {
      const cleanupError = await cleanupResources([
        async () => {
          await app?.close();
        },
        async () => {
          await worker?.close();
        },
        async () => direct.close(),
        async () => deleteRabbitNamespace(base.rabbitUrl, name),
        async () => deleteRedis(base.redisUrl, name),
      ]);
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } catch (error) {
        await admin.end().catch(() => undefined);
        if (!cleanupError) throw error;
        console.error(error);
        throw cleanupError;
      }
      await admin.end().catch(() => undefined);
      if (cleanupError) throw cleanupError;
    },
  };
};

export const withCleanup = async <T>(
  run: () => Promise<T>,
  cleanup: () => Promise<unknown>,
) => {
  let failure: unknown;
  try {
    return await run();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (!failure) throw cleanupError;
      console.error(cleanupError);
    }
  }
};

const deleteRedis = async (url: string, name: string) => {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
  });
  try {
    await redis.del(`${name}:simulation-lock`);
  } finally {
    redis.disconnect();
  }
};
