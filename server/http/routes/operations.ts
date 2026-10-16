import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { replaySchema, runbookSchema } from "../../../shared/operations";
import type { PostgresStore } from "../../db/postgres";
import {
  getFailedJob,
  getRunbookRun,
  listDependencies,
  listFailedJobs,
  listNotifications,
  listRunbookRuns,
  listRunbooks,
} from "../../db/operations-queries";
import { OperationsService } from "../../operations/service";
import { administrator } from "../../security/auth";
import { auditActor } from "../../security/identity";

const pageQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  cursor: z.string().min(1).optional(),
  state: z.string().min(1).max(40).optional(),
  open: z.enum(["true", "false"]).optional(),
});

export const operationsRoutes = (
  app: FastifyInstance,
  store: PostgresStore,
) => {
  const operations = new OperationsService(store);
  app.get("/api/failed-jobs", async (req) => {
    const query = pageQuery.parse(req.query);
    return listFailedJobs(
      store.pool,
      query.limit,
      query.cursor,
      query.open === "true",
    );
  });
  app.get<{ Params: { id: string } }>("/api/failed-jobs/:id", async (req) => {
    const generation = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse((req.query as { generation?: string }).generation);
    return getFailedJob(store.pool, req.params.id, generation);
  });
  app.post<{ Params: { id: string } }>(
    "/api/failed-jobs/:id/replay",
    { preHandler: administrator },
    async (req) => {
      const input = replaySchema.parse(req.body);
      return operations.replay(
        req.params.id,
        input.generation,
        auditActor(),
        input.reason,
      );
    },
  );
  app.get("/api/dependencies", async () => listDependencies(store.pool));
  app.post("/api/dependencies", { preHandler: administrator }, async (req) => {
    const input = z
      .object({ serviceId: z.string().min(1), dependsOn: z.string().min(1) })
      .parse(req.body);
    return operations.addDependency(
      input.serviceId,
      input.dependsOn,
      auditActor(),
    );
  });
  app.get("/api/notifications", async (req) => {
    const query = pageQuery.parse(req.query);
    return listNotifications(store.pool, query.limit, query.cursor);
  });
  app.get("/api/runbooks", async (req) => {
    const query = pageQuery.parse(req.query);
    return listRunbooks(store.pool, query.limit, query.cursor);
  });
  app.post("/api/runbooks", { preHandler: administrator }, async (req) => {
    const definition = runbookSchema.parse(req.body);
    return operations.createRunbook(definition, auditActor());
  });
  app.post("/api/runbook-runs", async (req) => {
    const input = z
      .object({ runbookId: z.string().uuid(), incidentId: z.string().min(1) })
      .parse(req.body);
    return operations.startRun(input.runbookId, input.incidentId, auditActor());
  });
  app.get("/api/runbook-runs", async (req) => {
    const query = pageQuery.parse(req.query);
    return listRunbookRuns(store.pool, query.limit, query.cursor, query.state);
  });
  app.get<{ Params: { id: string } }>("/api/runbook-runs/:id", async (req) =>
    getRunbookRun(store.pool, z.string().uuid().parse(req.params.id)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/runbook-runs/:id/cancel",
    async (req) => {
      const id = z.string().uuid().parse(req.params.id);
      const { version } = z
        .object({ version: z.number().int().positive() })
        .parse(req.body);
      return operations.cancelRun(id, version, auditActor());
    },
  );
  app.post(
    "/api/maintenance/retention",
    { preHandler: administrator },
    async (req) => {
      const input = z
        .object({
          days: z.number().int().min(1).max(3650),
          dryRun: z.boolean().default(true),
        })
        .parse(req.body);
      return operations.retain(input.days, input.dryRun, auditActor());
    },
  );
};
