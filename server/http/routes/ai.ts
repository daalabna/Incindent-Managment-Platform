import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { analysisResponseSchema, analysisJobSchema } from "../../../shared/ai";
import type { AiService } from "../../ai/service";
import { auditActor } from "../../security/identity";
import { contract } from "../contract";

export const aiRoutes = (app: FastifyInstance, ai: AiService) => {
  app.get<{ Params: { id: string } }>(
    "/api/incidents/:id/analysis",
    async (req) =>
      contract(analysisResponseSchema, await ai.status(req.params.id)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/incidents/:id/analysis",
    async (req, reply) => {
      const { version } = z
        .object({ version: z.number().int().positive() })
        .strict()
        .parse(req.body);
      const job = await ai.request(req.params.id, version, auditActor());
      return reply
        .code(job.state === "succeeded" ? 200 : 202)
        .send(contract(analysisJobSchema, job));
    },
  );
};
