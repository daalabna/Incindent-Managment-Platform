import { createServer } from "node:http";
import { readConfig } from "../config";
import { formatError } from "../domain/errors";
import { DistributedRuntime } from "../runtime/runtime";
import { encodeHealth } from "../runtime/worker-health";
import { startTelemetry, stopTelemetry } from "../observability/telemetry";
startTelemetry();
if (process.env.EMBEDDED_WORKER !== "false")
  console.warn(
    "[sentinel] Separate worker running: set EMBEDDED_WORKER=false on the API to avoid duplicate consumers.",
  );

const runtime = new DistributedRuntime(
  { ...readConfig(), embeddedWorker: true },
  () => undefined,
  (message) => console.warn(message),
);
await runtime.start();
const port = Number(process.env.WORKER_PORT ?? 4002);
const health = createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404);
    res.end();
    return;
  }
  void runtime
    .health()
    .then((body) => {
      const encoded = encodeHealth(body);
      res.writeHead(encoded.statusCode, { "content-type": "application/json" });
      res.end(JSON.stringify(encoded.body));
    })
    .catch((error: unknown) => {
      console.warn(formatError(error));
      const encoded = encodeHealth(undefined);
      res.writeHead(encoded.statusCode, { "content-type": "application/json" });
      res.end(JSON.stringify(encoded.body));
    });
});
let listening = false;
health.on("error", (error) => {
  console.warn(formatError(error));
  if (listening) return;
  void runtime.close().finally(() => process.exit(1));
});
await new Promise<void>((resolve) => {
  health.listen(port, "127.0.0.1", () => {
    listening = true;
    resolve();
  });
});
console.info("Sentinel worker ready: PostgreSQL + Redis + RabbitMQ");
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    health.close();
    await runtime.close();
    await stopTelemetry();
    process.exit(0);
  });
