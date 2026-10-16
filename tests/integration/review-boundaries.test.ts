// Regression checks for the boundaries found in the repeated review.
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { validateAnalysis } from "../../server/ai/validate";
import { citeLimitations, type AnalysisContext } from "../../server/ai/context";
import { fixtureAnalysis } from "../support/ai-fixture";
import { createIsolated, withCleanup } from "../support/isolated-infra";
import { readTimelinePage } from "../../server/db/incident-timeline";
import { listNotifications } from "../../server/db/operations-queries";
import { notificationTick } from "../../server/operations/notifications";
import { event } from "./helpers";

it("rejects substring numbers and never confirms a model root cause", () => {
  const context: AnalysisContext = {
    incidentId: "INC-1",
    incidentVersion: 1,
    sources: [
      { id: "event:1", kind: "event", label: "sample", text: '{"value":1234}' },
    ],
    limitations: [],
  };
  const result = fixtureAnalysis(context).result;
  result.facts = [{ text: "Измеренное значение: 234.", sources: ["event:1"] }];
  result.postmortem.rootCause = {
    text: "Причина не подтверждена.",
    sources: ["event:1"],
  };
  expect(() => validateAnalysis(result, citeLimitations(context))).toThrow(
    /число/,
  );
  result.facts = [{ text: "Измеренное значение: 1234.", sources: ["event:1"] }];
  expect(
    validateAnalysis(result, citeLimitations(context)).statuses.rootCause,
  ).toBe("unconfirmed");
});

it("preserves numeric ordering and microseconds, lists pending audits and allows delivery progress", async () => {
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
      for (const sequence of [9, 10]) {
        await f.direct.pool.query(
          "INSERT INTO incident_timeline(sequence,id,incident_id,at,actor,text) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,'2026-10-12T12:00:00Z','review','same timestamp')",
          [sequence, randomUUID(), incident.id],
        );
      }
      const page = await readTimelinePage(f.direct.pool, incident.id, 1);
      expect(page[0]!.sequence).toBe("10");
      expect(
        (await readTimelinePage(f.direct.pool, incident.id, 1, page[0]))[0]!
          .sequence,
      ).toBe("9");
      await f.direct.pool.query(
        "DELETE FROM incident_timeline WHERE incident_id=$1",
        [incident.id],
      );
      for (const at of [
        "2026-10-12T12:00:00.000900Z",
        "2026-10-12T12:00:00.000800Z",
      ]) {
        await f.direct.pool.query(
          "INSERT INTO incident_timeline(id,incident_id,at,actor,text) VALUES($1,$2,$3,'review','precision')",
          [randomUUID(), incident.id, at],
        );
      }
      const precise = await readTimelinePage(f.direct.pool, incident.id, 1);
      expect(
        await readTimelinePage(f.direct.pool, incident.id, 1, precise[0]),
      ).toHaveLength(1);
      await f.direct.pool.query(
        "UPDATE notification_jobs SET state='audit_pending',delivery_dry_run=false WHERE incident_id=$1",
        [incident.id],
      );
      expect((await listNotifications(f.direct.pool, 50)).items[0]!.state).toBe(
        "audit_pending",
      );
      const { app } = await f.startApi();
      const response = await app.inject({
        method: "GET",
        url: "/api/notifications",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().items[0].state).toBe("audit_pending");
      await f.direct.pool.query(
        "INSERT INTO notification_jobs(id,incident_id,adapter,payload,created_at) VALUES($1,$2,'journal:second','{}',now()+interval '1 second')",
        [randomUUID(), incident.id],
      );
      await f.direct.pool.query(
        "CREATE FUNCTION repeat_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
      );
      await f.direct.pool.query(
        "CREATE TRIGGER repeat_reject_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION repeat_reject_audit()",
      );
      await expect(notificationTick(f.direct)).rejects.toThrow(
        "audit unavailable",
      );
      await notificationTick(f.direct);
      const later = (
        await f.direct.pool.query(
          "SELECT state,attempts FROM notification_jobs WHERE adapter='journal:second'",
        )
      ).rows[0];
      expect(later).toMatchObject({ state: "audit_pending", attempts: 1 });
      await f.direct.pool.query(
        "DROP TRIGGER repeat_reject_audit ON audit_entries",
      );
      await f.direct.pool.query(
        "UPDATE notification_jobs SET available_at=now()-interval '1 second' WHERE state='audit_pending'",
      );
      await notificationTick(f.direct);
      const receipt = await f.direct.pool.query(
        "SELECT payload->>'text' AS text FROM audit_entries WHERE payload->>'text' LIKE 'Notification % delivered'",
      );
      expect(receipt.rowCount).toBe(1); // stored delivery mode, independent of current environment
    },
    () => f.dispose(),
  );
});
