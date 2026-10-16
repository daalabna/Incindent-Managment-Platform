import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { validateAnalysis } from "../../server/ai/validate";
import { citeLimitations, type AnalysisContext } from "../../server/ai/context";
import { fixtureAnalysis } from "../support/ai-fixture";
import { createIsolated, withCleanup } from "../support/isolated-infra";
import {
  encodeTimelineCursor,
  readTimelinePage,
} from "../../server/db/incident-timeline";
import { event } from "./helpers";
import { readSecurityConfig } from "../../server/security/config";
import { notificationTick } from "../../server/operations/notifications";

it("rejects invalid AUTH_REQUIRED values at config read", () => {
  expect(() => readSecurityConfig({ AUTH_REQUIRED: "treu" })).toThrow(
    /AUTH_REQUIRED/,
  );
  expect(readSecurityConfig({ AUTH_REQUIRED: "true" }).authRequired).toBe(true);
  expect(readSecurityConfig({}).authRequired).toBe(false);
});

it("rejects invented numbers and causal rootCause marked as observed", () => {
  const context: AnalysisContext = {
    incidentId: "INC-1",
    incidentVersion: 1,
    sources: [
      { id: "event:1", kind: "event", label: "sample", text: '{"value":1}' },
    ],
    limitations: [],
  };
  const result = fixtureAnalysis(context).result;
  result.facts = [
    { text: "Измеренное значение: 999999.", sources: ["event:1"] },
  ];
  expect(() => validateAnalysis(result, citeLimitations(context))).toThrow(
    /999999|число/,
  );
  result.facts = fixtureAnalysis(context).result.facts;
  result.postmortem.rootCause = {
    text: "Причина: повреждение диска.",
    sources: ["event:1"],
  };
  expect(() => validateAnalysis(result, citeLimitations(context))).toThrow(
    /Причинный вывод|hypotheses/i,
  );
});

it("paginates timeline with composite cursor and retries notification audit", async () => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const input = event();
      await f.direct.accept(input);
      await f.direct.processEvent(input.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      await f.direct.pool.query(
        "DELETE FROM incident_timeline WHERE incident_id=$1",
        [incident.id],
      );
      const first = randomUUID(),
        second = randomUUID();
      await f.direct.pool.query(
        "INSERT INTO incident_timeline(id,incident_id,at,actor,text) VALUES($1,$2,'2026-10-12T12:00:00Z','review','newer timestamp')",
        [first, incident.id],
      );
      await f.direct.pool.query(
        "INSERT INTO incident_timeline(id,incident_id,at,actor,text) VALUES($1,$2,'2026-10-12T11:00:00Z','review','later insert, older timestamp')",
        [second, incident.id],
      );
      const page = await readTimelinePage(f.direct.pool, incident.id, 1);
      expect(page[0]!.id).toBe(first);
      expect(typeof page[0]!.sequence).toBe("string");
      const next = await readTimelinePage(f.direct.pool, incident.id, 1, {
        at: page[0]!.at,
        sequence: page[0]!.sequence,
      });
      expect(next.map((row) => row.id)).toEqual([second]);
      expect(encodeTimelineCursor(page[0]!.at, page[0]!.sequence)).toContain(
        "|",
      );

      await f.direct.pool.query(
        "CREATE FUNCTION reject_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
      );
      await f.direct.pool.query(
        "CREATE TRIGGER reject_review_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION reject_review_audit()",
      );
      await notificationTick(f.direct);
      const job = (
        await f.direct.pool.query<{ id: string; state: string; error: string }>(
          "SELECT id,state,error FROM notification_jobs WHERE incident_id=$1",
          [incident.id],
        )
      ).rows[0];
      expect(job).toMatchObject({
        state: "audit_pending",
        error: "audit unavailable",
      });
      await f.direct.pool.query(
        "DROP TRIGGER reject_review_audit ON audit_entries",
      );
      await notificationTick(f.direct);
      const settled = (
        await f.direct.pool.query<{ state: string }>(
          "SELECT state FROM notification_jobs WHERE id=$1",
          [job!.id],
        )
      ).rows[0];
      expect(settled?.state).toBe("sent");
      const audit = await f.direct.pool.query(
        "SELECT id FROM audit_entries WHERE payload->>'text' LIKE $1",
        [`Notification ${job!.id}%`],
      );
      expect(audit.rowCount).toBe(1);
    },
    () => f.dispose(),
  );
});
