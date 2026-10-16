import { expect, it } from "vitest";
import { decodeTimelineCursor } from "../../server/db/incident-timeline";
import { viewJob, type JobRow } from "../../server/ai/job-view";
import { promptVersion } from "../../server/ai/config";
import { fixtureAnalysis } from "../support/ai-fixture";

it.each([
  "2026-02-30T00:00:00Z|1",
  "2026-10-12T12:00:00Z|abc",
  "2026-10-12T12:00:00Z|0",
  "2026-10-12T12:00:00Z|9223372036854775808",
  "bad|1",
])("rejects invalid timeline cursor %s before SQL", (cursor) => {
  expect(() => decodeTimelineCursor(cursor)).toThrow("Invalid timeline cursor");
});
it("keeps all six timestamp digits and bigint precision", () => {
  expect(
    decodeTimelineCursor("2026-10-12T12:00:00.123456Z|9223372036854775807"),
  ).toEqual({
    at: "2026-10-12T12:00:00.123456Z",
    sequence: "9223372036854775807",
  });
});
it("does not expose an analysis accepted by an older validator", () => {
  const context = {
    incidentId: "INC-1",
    incidentVersion: 1,
    limitations: [],
    sources: [
      {
        id: "event:1",
        kind: "event" as const,
        label: "latency",
        text: '{"value":1234}',
      },
    ],
  };
  const valid = fixtureAnalysis(context).result;
  const row: JobRow = {
    id: "11111111-1111-4111-8111-111111111111",
    incident_id: "INC-1",
    incident_version: 1,
    context_hash: "hash",
    context,
    state: "succeeded",
    model: "test",
    prompt_version: "incident-v3",
    attempts: 1,
    context_retained: true,
    reusable: true,
    created_at: new Date(),
    completed_at: new Date(),
    result: valid,
    error: null,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
    duration_ms: 1,
  };
  expect(viewJob(row, true)).toMatchObject({
    state: "incompatible",
    result: null,
  });
  expect(viewJob({ ...row, prompt_version: promptVersion }, false).state).toBe(
    "succeeded",
  );
  const invented = {
    ...valid,
    facts: [
      { text: "Обнаружено повреждение диска без числа.", sources: ["event:1"] },
    ],
  };
  expect(
    viewJob({ ...row, prompt_version: promptVersion, result: invented }, false)
      .state,
  ).toBe("incompatible");
});
