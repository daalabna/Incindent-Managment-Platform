// Calls the real worker for both deliveries, rather than duplicating its SQL.
import { expect, it, vi } from "vitest";
import { validateAnalysis } from "../../server/ai/validate";
import { citeLimitations, type AnalysisContext } from "../../server/ai/context";
import { fixtureAnalysis } from "../support/ai-fixture";
import { createIsolated, withCleanup } from "../support/isolated-infra";
import { notificationTick } from "../../server/operations/notifications";
import { event } from "./helpers";

it.each([
  "999мс",
  "999ms",
  "999\u00a0мс",
  "-999мс",
  "9,99мс",
  "9.99ms",
  "9e9ms",
])("rejects a fabricated measurement %s", (measurement) => {
  const context: AnalysisContext = {
    incidentId: "INC-1",
    incidentVersion: 1,
    sources: [
      {
        id: "event:1",
        kind: "event",
        label: "latency ms",
        text: '{"value":1}',
      },
    ],
    limitations: [],
  };
  const result = fixtureAnalysis(context).result;
  result.facts = [
    { text: `latency составляет ${measurement}.`, sources: ["event:1"] },
  ];
  expect(() => validateAnalysis(result, citeLimitations(context))).toThrow(
    /число/,
  );
  result.facts = [{ text: "latency составляет 1ms.", sources: ["event:1"] }];
  expect(validateAnalysis(result, citeLimitations(context)).facts).toEqual(
    result.facts,
  );
});

it.each([0, 3])(
  "keeps late success after a newer failure with %i prior attempts",
  async (priorAttempts) => {
    const f = await createIsolated();
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let first: Promise<void> | undefined;
    await withCleanup(
      async () => {
        const input = event();
        await f.direct.accept(input);
        await f.direct.processEvent(input.id);
        await f.direct.pool.query(
          "UPDATE notification_jobs SET adapter='webhook',attempts=$1",
          [priorAttempts],
        );
        vi.stubEnv("NOTIFICATION_DELIVERY", "enabled");
        vi.stubEnv("NOTIFICATION_WEBHOOK_URL", "https://example.invalid/hook");
        vi.stubEnv("NOTIFICATION_WEBHOOK_SECRET", "test-only");
        const transport = vi
          .fn()
          .mockImplementationOnce(() => {
            entered();
            return response;
          })
          .mockRejectedValueOnce(new Error("second worker failed"));
        vi.stubGlobal("fetch", transport);
        first = notificationTick(f.direct);
        await started;
        await f.direct.pool.query(
          "UPDATE notification_jobs SET lease_until=now()-interval '1 second'",
        );
        await notificationTick(f.direct);
        release(new Response(null, { status: 200 }));
        await first;
        expect(
          (
            await f.direct.pool.query(
              "SELECT state,attempts FROM notification_jobs",
            )
          ).rows[0],
        ).toMatchObject({ state: "sent", attempts: priorAttempts + 2 });
        expect(
          (
            await f.direct.pool.query(
              "SELECT id FROM audit_entries WHERE payload->>'text' LIKE 'Notification % delivered'",
            )
          ).rowCount,
        ).toBe(1);
        await notificationTick(f.direct);
        expect(transport).toHaveBeenCalledTimes(2);
      },
      async () => {
        release?.(new Response(null, { status: 200 }));
        await first?.catch(() => undefined);
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        await f.dispose();
      },
    );
  },
);
