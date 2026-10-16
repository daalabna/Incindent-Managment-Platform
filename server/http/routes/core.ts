import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  eventSchema,
  healthResponseSchema,
  incidentPageSchema,
  incidentSchema,
  incidentUpdateSchema,
  ruleSchema,
  summarySchema,
} from "../../../shared/contracts";
import { contract } from "../contract";
import { toPublicIncident } from "../../domain/apply";
import type { Runtime } from "../../runtime/runtime";
import { administrator } from "../../security/auth";
import { auditActor, identityContext } from "../../security/identity";
import { LOCAL_OPERATOR } from "../../security/actors";
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
  readTimelineEntries,
  readTimelinePage,
} from "../../db/incident-timeline";
import type { PostgresStore } from "../../db/postgres";
import { DomainError } from "../../domain/errors";

export const registerCoreRoutes = (
  app: FastifyInstance,
  runtime: Runtime,
  store?: PostgresStore,
) => {
  app.get("/api/live", () => ({ status: "ok" }));
  app.get("/api/health", async (_req, reply) => {
    const health = contract(healthResponseSchema, await runtime.health());
    return reply.code(health.status === "ok" ? 200 : 503).send(health);
  });
  app.get("/api/state", async () =>
    contract(summarySchema, await runtime.summary()),
  );
  app.get("/api/summary", async () =>
    contract(summarySchema, await runtime.summary()),
  );
  app.get("/api/incidents", async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(200).default(50),
        cursor: z.string().min(1).optional(),
        status: z.enum(["active", "resolved", "all"]).default("all"),
        q: z.string().trim().max(200).default(""),
      })
      .parse(req.query);
    return contract(
      incidentPageSchema,
      await runtime.incidents(query.limit, query.cursor, query.status, query.q),
    );
  });
  app.get<{ Params: { id: string } }>("/api/incidents/:id", async (req) => {
    const { timeline } = z
      .object({ timeline: z.enum(["full", "none"]).default("none") })
      .parse(req.query);
    if (store) {
      const row = (
        await store.pool.query<{
          payload: import("../../../shared/domain").Incident;
        }>("SELECT payload FROM incidents WHERE id=$1", [req.params.id])
      ).rows[0];
      if (!row) throw new DomainError("Incident not found", 404);
      if (timeline === "none")
        return contract(
          incidentSchema,
          toPublicIncident({ ...row.payload, timeline: [] }),
        );
      const entries = await readTimelineEntries(store.pool, req.params.id, 50);
      return contract(
        incidentSchema,
        toPublicIncident({ ...row.payload, timeline: entries }),
      );
    }
    const incident = await runtime.incident(req.params.id);
    return contract(
      incidentSchema,
      toPublicIncident(
        timeline === "none" ? { ...incident, timeline: [] } : incident,
      ),
    );
  });
  app.get<{ Params: { id: string } }>(
    "/api/incidents/:id/timeline",
    async (req) => {
      const query = z
        .object({
          limit: z.coerce.number().int().positive().max(100).default(50),
          before: z.string().min(3).optional(),
        })
        .parse(req.query);
      const before = query.before
        ? decodeTimelineCursor(query.before)
        : undefined;
      if (!store) {
        // SQLite/demo offers the same endpoint; errors never select a fallback in the UI.
        const incident = await runtime.incident(req.params.id);
        const items = incident.timeline
          .map((entry, index) => ({ ...entry, sequence: String(index + 1) }))
          .sort(
            (a, b) =>
              Date.parse(b.at) - Date.parse(a.at) ||
              Number(b.sequence) - Number(a.sequence),
          )
          .filter(
            (entry) =>
              !before ||
              Date.parse(entry.at) < Date.parse(before.at) ||
              (Date.parse(entry.at) === Date.parse(before.at) &&
                BigInt(entry.sequence) < BigInt(before.sequence)),
          )
          .slice(0, query.limit);
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            items.length === query.limit && last
              ? encodeTimelineCursor(last.at, last.sequence)
              : null,
        };
      }
      if (
        !(
          await store.pool.query("SELECT 1 FROM incidents WHERE id=$1", [
            req.params.id,
          ])
        ).rowCount
      )
        throw new DomainError("Incident not found", 404);
      const items = await readTimelinePage(
        store.pool,
        req.params.id,
        query.limit,
        before,
      );
      const last = items[items.length - 1];
      return {
        items,
        nextCursor:
          items.length === query.limit && last
            ? encodeTimelineCursor(last.at, last.sequence)
            : null,
      };
    },
  );
  app.get("/api/activity", async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(300).default(300),
        offset: z.coerce.number().int().nonnegative().default(0),
      })
      .parse(req.query);
    return runtime.activity(query.limit, query.offset);
  });
  app.post("/api/events", async (req, reply) => {
    const result = await runtime.ingest(eventSchema.parse(req.body));
    return reply.code(runtime.mode === "distributed" ? 202 : 200).send(result);
  });
  app.get<{ Params: { id: string } }>("/api/events/:id", async (req) =>
    runtime.eventStatus(req.params.id),
  );
  app.patch<{ Params: { id: string } }>("/api/incidents/:id", async (req) => {
    const { version, ...patch } = incidentUpdateSchema.parse(req.body);
    return contract(
      incidentSchema,
      toPublicIncident(
        await runtime.update(req.params.id, version, patch, auditActor()),
      ),
    );
  });
  app.post<{ Params: { id: string } }>(
    "/api/incidents/:id/assign-me",
    async (req) => {
      const { version } = z
        .object({ version: z.number().int().positive() })
        .parse(req.body);
      return contract(
        incidentSchema,
        toPublicIncident(
          await runtime.update(
            req.params.id,
            version,
            {
              assignee: identityContext.getStore()?.username ?? LOCAL_OPERATOR,
            },
            auditActor(),
          ),
        ),
      );
    },
  );
  app.post("/api/rules", { preHandler: administrator }, async (req) =>
    runtime.addRule(ruleSchema.parse(req.body), auditActor()),
  );
  app.patch<{ Params: { id: string } }>(
    "/api/rules/:id",
    { preHandler: administrator },
    async (req) =>
      runtime.toggleRule(
        req.params.id,
        z.object({ enabled: z.boolean() }).parse(req.body).enabled,
        auditActor(),
      ),
  );
};
