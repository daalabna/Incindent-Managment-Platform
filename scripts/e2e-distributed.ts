import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { readConfig } from "../server/config";
import { cleanupResources } from "../tests/support/cleanup";
import { deleteRabbitNamespace } from "../tests/support/rabbit-namespace";

const deleteRedis = async (url: string, namespace: string) => {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
  });
  try {
    await redis.del(`${namespace}:simulation-lock`);
  } finally {
    redis.disconnect();
  }
};

const config = readConfig();
const name = `sentinel_e2e_${randomUUID().replaceAll("-", "")}`;
const database = new URL(config.databaseUrl);
database.pathname = `/${name}`;
const admin = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 3000,
});
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test"],
      {
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          E2E_DISTRIBUTED: "true",
          AI_ENABLED: "false",
          DATABASE_URL: database.toString(),
          REDIS_URL: config.redisUrl,
          RABBITMQ_URL: config.rabbitUrl,
          INFRA_NAMESPACE: name,
          EMBEDDED_WORKER: "true",
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  const cleanupError =
    created && /^sentinel_e2e_[a-f0-9]{32}$/.test(name)
      ? await cleanupResources([
          () => deleteRabbitNamespace(config.rabbitUrl, name),
          () => deleteRedis(config.redisUrl, name),
          () => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
        ])
      : undefined;
  await admin.end().catch(() => undefined);
  if (cleanupError) {
    console.error(cleanupError);
    if (!process.exitCode) process.exitCode = 1;
  }
}
