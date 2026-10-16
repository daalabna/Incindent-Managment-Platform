import Fastify from "fastify";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { DomainError } from "../domain/errors";
import {
  DistributedRuntime,
  localRuntime,
  type Runtime,
} from "../runtime/runtime";
import type { InfrastructureConfig } from "../config";
import { installSecurity } from "../security/auth";
import { LOCAL_OPERATOR } from "../security/actors";
import { readSecurityConfig, trustProxyOption } from "../security/config";
import { operationsRoutes } from "./routes/operations";
import { instrumentHttp } from "../observability/telemetry";
import { aiRoutes } from "./routes/ai";
import { simulationRoutes } from "./routes/simulation";
import { createWsHub } from "./ws-hub";
import { isAllowedHost } from "./hosts";
import { registerCoreRoutes } from "./routes/core";

/**
 * `string` path = SQLite/in-memory for unit tests and ALLOW_SQLITE demos.
 * Production entry (`server/entry/api.ts`) requires distributed config unless ALLOW_SQLITE=true.
 */
export const createApp = async (
  database: string | InfrastructureConfig = ":memory:",
  logger = false,
) => {
  const security = readSecurityConfig();
  const app = Fastify({
    logger,
    bodyLimit: 64 * 1024,
    trustProxy: trustProxyOption(security.trustedProxies),
  });
  instrumentHttp(app);
  const hub = createWsHub();
  const runtime: Runtime =
    typeof database === "string"
      ? localRuntime(database, hub.broadcast)
      : new DistributedRuntime(database, hub.broadcast, (message) =>
          app.log.warn(message),
        );
  if (runtime instanceof DistributedRuntime) await runtime.start();
  let simulation: ReturnType<typeof setTimeout> | undefined;
  let simulationToken: string | undefined;
  let simulationWork: Promise<void> | undefined;
  let closing = false;
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        message: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    if (error instanceof DomainError)
      return reply.code(error.statusCode).send({ message: error.message });
    app.log.error(error);
    const status =
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    return reply.code(status).send({
      message:
        status < 500 && error instanceof Error
          ? error.message
          : "Internal server error",
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    const host = Array.isArray(req.headers.host)
      ? req.headers.host[0]
      : req.headers.host;
    if (!isAllowedHost(host, security.allowedHosts))
      return reply.code(403).send({ message: "Untrusted host" });
    const origin = req.headers.origin;
    if (!origin) return;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return reply.code(403).send({ message: "Invalid origin" });
    }
    if (!isAllowedHost(originHost, security.allowedHosts))
      return reply
        .code(403)
        .send({ message: "Cross-origin requests are not allowed" });
  });
  let sessionActive: Awaited<ReturnType<typeof installSecurity>> | undefined;
  if (security.authRequired && !(runtime instanceof DistributedRuntime))
    throw new Error("Authentication requires PostgreSQL mode");
  if (runtime instanceof DistributedRuntime) {
    if (security.authRequired)
      sessionActive = await installSecurity(
        app,
        runtime.store,
        runtime.redis,
        typeof database === "string"
          ? "default"
          : (database.tenantId ?? "default"),
      );
    operationsRoutes(app, runtime.store);
    aiRoutes(app, runtime.ai);
  } else
    app.get("/api/incidents/:id/analysis", () => ({
      enabled: false,
      reason: "AI-анализ доступен в режиме PostgreSQL.",
      job: null,
    }));
  if (!security.authRequired)
    app.get("/api/auth/me", () => ({
      username: LOCAL_OPERATOR,
      role: "admin",
      tenant: "demo",
      csrf: "",
      demo: true,
    }));
  registerCoreRoutes(
    app,
    runtime,
    runtime instanceof DistributedRuntime ? runtime.store : undefined,
  );
  await app.register(websocket);
  app.get("/ws", { websocket: true }, (socket, req) => {
    hub.add(socket);
    const timer = sessionActive
      ? setInterval(() => {
          void sessionActive!(req)
            .then((valid) => {
              if (!valid) socket.close(1008, "Session expired");
            })
            .catch(() => socket.close(1011, "Authentication unavailable"));
        }, 10000)
      : undefined;
    socket.on("close", () => {
      clearInterval(timer);
      hub.remove(socket);
    });
  });
  simulationRoutes(app, runtime, {
    getClosing: () => closing,
    setTimer: (timer) => {
      simulation = timer;
    },
    getTimer: () => simulation,
    setToken: (token) => {
      simulationToken = token;
    },
    getToken: () => simulationToken,
    setWork: (work) => {
      simulationWork = work;
    },
  });
  const dist = resolve("dist");
  if (existsSync(dist)) {
    await app.register(staticFiles, { root: dist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ message: "Not found" })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("preClose", async () => {
    closing = true;
    clearTimeout(simulation);
    hub.closeAll();
  });
  app.addHook("onClose", async () => {
    await simulationWork;
    if (simulationToken) await runtime.releaseSimulation(simulationToken);
    await runtime.close();
  });
  return { app, runtime };
};
