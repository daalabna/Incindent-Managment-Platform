import { createApp } from "../http/app";
import { readConfig } from "../config";
import { startTelemetry, stopTelemetry } from "../observability/telemetry";

startTelemetry();
const config = readConfig();
if (
  config.mode === "distributed" &&
  process.env.AUTH_REQUIRED !== "true" &&
  process.env.AUTH_REQUIRED !== "1" &&
  (process.env.AUTH_REQUIRED ?? "").toLowerCase() !== "yes"
)
  console.warn(
    "[sentinel] AUTH_REQUIRED is off: API is open. Set AUTH_REQUIRED=true for production.",
  );
if (config.mode === "local" && process.env.ALLOW_SQLITE !== "true") {
  console.error(
    "SENTINEL_MODE=local is not a production path. Use distributed/PostgreSQL, or set ALLOW_SQLITE=true for demos only.",
  );
  process.exit(1);
}
const { app } = await createApp(
  config.mode === "local"
    ? (process.env.DATABASE_PATH ?? "data/sentinel.db")
    : config,
  true,
);
try {
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4000),
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    await stopTelemetry();
    process.exit(0);
  });
