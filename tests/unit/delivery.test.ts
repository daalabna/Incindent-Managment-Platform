import { expect, it } from "vitest";
import { deliveryReceipt } from "../../server/domain/delivery";

it("reports failed duplicates as failed instead of queued", () => {
  const row = {
    processed_at: null,
    incident_id: null,
    failure: "Processing failed after retries; inspect dead-letter queue",
  };
  expect(deliveryReceipt("event-1", row, true)).toEqual({
    eventId: "event-1",
    duplicate: true,
    status: "failed",
    incidentId: null,
    error: row.failure,
  });
  expect(
    deliveryReceipt("event-1", { ...row, failure: null }, false).status,
  ).toBe("queued");
  expect(
    deliveryReceipt(
      "event-1",
      { ...row, processed_at: new Date(), failure: null },
      false,
    ).status,
  ).toBe("processed");
});
