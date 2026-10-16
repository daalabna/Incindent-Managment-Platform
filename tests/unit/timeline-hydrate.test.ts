import { expect, it } from "vitest";
import type { Incident } from "../../shared/domain";
import { hydrateIncidentsTimelines } from "../../server/db/incident-timeline";

const base = (id: string, timeline: Incident["timeline"]): Incident => ({
  id,
  title: "t",
  serviceId: "search-api",
  severity: "P1",
  status: "triggered",
  assignee: null,
  assigneeEpoch: 0,
  alerts: 1,
  version: 1,
  createdAt: new Date().toISOString(),
  resolvedAt: null,
  timeline,
});

it("uses empty table timeline even when payload still carries entries", async () => {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  };
  const leftover = base("INC-1", [
    {
      id: "00000000-0000-4000-8000-000000000001",
      at: new Date().toISOString(),
      actor: "ops",
      text: "from payload",
    },
  ]);
  const [hydrated] = await hydrateIncidentsTimelines(client as never, [
    leftover,
  ]);
  expect(hydrated?.timeline).toEqual([]);
  expect(queries[0]).toMatch(/incident_timeline/);
});

it("hydrates from table rows in order", async () => {
  const at = new Date("2026-01-01T00:00:00.000Z");
  const client = {
    query: async () => ({
      rows: [
        {
          incident_id: "INC-1",
          id: "00000000-0000-4000-8000-000000000002",
          at,
          actor: "ops",
          text: "from table",
        },
      ],
    }),
  };
  const [hydrated] = await hydrateIncidentsTimelines(client as never, [
    base("INC-1", []),
  ]);
  expect(hydrated?.timeline).toEqual([
    {
      id: "00000000-0000-4000-8000-000000000002",
      at: at.toISOString(),
      actor: "ops",
      text: "from table",
    },
  ]);
});
