import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { DomainError } from "../../domain/errors";
import type { Runtime } from "../../runtime/runtime";

export const simulationRoutes = (
  app: FastifyInstance,
  runtime: Runtime,
  state: {
    getClosing: () => boolean;
    setTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void;
    getTimer: () => ReturnType<typeof setTimeout> | undefined;
    setToken: (token: string | undefined) => void;
    getToken: () => string | undefined;
    setWork: (work: Promise<void> | undefined) => void;
  },
) => {
  app.post("/api/simulations", async (_req, reply) => {
    const token = await runtime.acquireSimulation();
    if (!token)
      return reply
        .code(409)
        .send({ message: "A simulation is already running" });
    state.setToken(token);
    const finish = async () => {
      clearTimeout(state.getTimer());
      state.setTimer(undefined);
      state.setToken(undefined);
      await runtime.releaseSimulation(token);
    };
    try {
      const snapshot = await runtime.snapshot();
      if (
        !snapshot.rules.some(
          (rule) =>
            rule.enabled &&
            rule.serviceId === "search-api" &&
            ((rule.metric === "error_rate" && rule.threshold < 12.8) ||
              (rule.metric === "latency" && rule.threshold < 1800)),
        )
      )
        throw new DomainError(
          "Enable a Search rule with error rate < 12.8 or latency < 1800 before running the demo",
        );
      const emit = (type: "latency" | "error_rate", value: number) =>
        runtime.ingest({
          id: randomUUID(),
          source: "search-api",
          type,
          value,
          timestamp: new Date().toISOString(),
        });
      await emit("latency", 1800);
      await emit("error_rate", 12.8);
      const tickMs = Number(process.env.SIMULATION_TICK_MS ?? 3000);
      const simulationTick =
        Number.isFinite(tickMs) && tickMs >= 0 && tickMs <= 60_000
          ? tickMs
          : 3000;
      let tick = 0;
      const runTick = async () => {
        try {
          if (state.getClosing() || !(await runtime.renewSimulation(token))) {
            await finish();
            return;
          }
          tick += 1;
          if (tick <= 3) {
            await emit("latency", 1800 + tick * 140);
            await emit("error_rate", 12.8 + tick);
            if (!state.getClosing())
              state.setTimer(setTimeout(schedule, simulationTick));
          } else {
            await emit("latency", 112);
            await emit("error_rate", 0);
            await runtime.record(
              "Simulation finished. Recovery events submitted; incident awaits operator resolution.",
              "demo generator",
            );
            await finish();
          }
        } catch (error) {
          app.log.error(error);
          await finish();
        }
      };
      const schedule = () => {
        state.setWork(runTick());
      };
      state.setTimer(setTimeout(schedule, simulationTick));
      return reply.code(202).send({ message: "Simulation started" });
    } catch (error) {
      await finish();
      throw error;
    }
  });
};
