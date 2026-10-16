import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { z } from "zod";
import { readAiConfig, type AiConfig } from "./ai/config";
if (existsSync(".env")) loadEnvFile(".env");
const schema = z.object({
  SENTINEL_MODE: z.enum(["distributed", "local"]).default("distributed"),
  DATABASE_URL: z
    .string()
    .url()
    .default(
      "postgresql://sentinel:local-development-only@127.0.0.1:15432/sentinel",
    ),
  REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
  RABBITMQ_URL: z
    .string()
    .url()
    .default("amqp://sentinel:local-development-only@127.0.0.1:5672"),
  INFRA_NAMESPACE: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("sentinel"),
  EMBEDDED_WORKER: z.enum(["true", "false"]).default("true"),
  TENANT_ID: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,30}$/)
    .default("default"),
  DATABASE_SCHEMA: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,40}$/)
    .optional(),
});
export type InfrastructureConfig = {
  databaseUrl: string;
  redisUrl: string;
  rabbitUrl: string;
  namespace: string;
  embeddedWorker: boolean;
  tenantId?: string;
  databaseSchema?: string;
  ai?: AiConfig;
};
export const readConfig = (): InfrastructureConfig & {
  mode: "distributed" | "local";
} => {
  const env = schema.parse(process.env);
  if (
    env.SENTINEL_MODE === "local" &&
    !process.env.VITEST &&
    process.env.ALLOW_SQLITE === "true"
  )
    console.warn(
      "[sentinel] ALLOW_SQLITE=true: SQLite demo mode. Production must use SENTINEL_MODE=distributed.",
    );
  return {
    mode: env.SENTINEL_MODE,
    ai: readAiConfig(),
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    rabbitUrl: env.RABBITMQ_URL,
    namespace:
      env.TENANT_ID === "default"
        ? env.INFRA_NAMESPACE
        : `${env.INFRA_NAMESPACE}_${env.TENANT_ID}`,
    embeddedWorker: env.EMBEDDED_WORKER === "true",
    tenantId: env.TENANT_ID,
    databaseSchema:
      env.DATABASE_SCHEMA ??
      (env.TENANT_ID === "default" ? "public" : `tenant_${env.TENANT_ID}`),
  };
};
