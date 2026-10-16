import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createIsolated, withCleanup } from "../support/isolated-infra";
import { event } from "./helpers";
import {
  startRun,
  runbookTick,
  cancelRun,
} from "../../server/operations/runbooks";

it.each([
  "own_two",
  "own_three",
  "comment",
  "manual_between_steps",
  "same_name_between_steps",
  "manual_between_undos",
])("preserves assignment ownership: %s", async (mode) => {
  const f = await createIsolated();
  await withCleanup(
    async () => {
      const e = event();
      await f.direct.accept(e);
      await f.direct.processEvent(e.id);
      const incident = (await f.direct.snapshot()).incidents[0]!;
      const id = randomUUID(),
        names =
          mode === "own_three" ? ["Alice", "Bob", "Carol"] : ["Alice", "Bob"];
      const definition = {
        name: "chain",
        timeoutSeconds: 3600,
        steps: [
          ...names.map((assignee) => ({ type: "assign", assignee })),
          { type: "wait", seconds: 300 },
        ],
      };
      await f.direct.pool.query(
        "INSERT INTO runbooks(id,name,definition) VALUES($1,$2,$3)",
        [id, definition.name, definition],
      );
      const run = await f.direct.transaction((c) =>
        startRun(c, id, incident.id, "review"),
      );
      const manual = async (same = false) => {
        let current = await f.direct.incident(incident.id);
        if (!same)
          current = await f.direct.update(current.id, current.version, {
            assignee: "Carol",
          });
        await f.direct.update(current.id, current.version, {
          assignee: "Alice",
        });
      };
      await runbookTick(f.direct);
      if (mode === "comment") {
        const current = await f.direct.incident(incident.id);
        await f.direct.update(current.id, current.version, {
          comment: "Unrelated operator note",
        });
      }
      const interrupted =
        mode === "manual_between_steps" || mode === "same_name_between_steps";
      if (interrupted) await manual(mode === "same_name_between_steps");
      for (let i = 1; i < names.length; i++) await runbookTick(f.direct);
      if (!interrupted) {
        const row = (
          await f.direct.pool.query(
            "SELECT version FROM runbook_runs WHERE id=$1",
            [run.id],
          )
        ).rows[0];
        await f.direct.transaction((c) =>
          cancelRun(c, run.id, row.version, "review"),
        );
      }
      await runbookTick(f.direct);
      if (mode === "manual_between_undos") await manual();
      for (let i = 0; i < names.length + 1; i++) await runbookTick(f.direct);
      const conflict = interrupted || mode === "manual_between_undos";
      expect((await f.direct.incident(incident.id)).assignee).toBe(
        conflict ? "Alice" : null,
      );
      expect(
        (
          await f.direct.pool.query(
            "SELECT state FROM runbook_runs WHERE id=$1",
            [run.id],
          )
        ).rows[0].state,
      ).toBe(conflict ? "compensation_failed" : "cancelled");
    },
    () => f.dispose(),
  );
});
