import type { EventReceipt } from "../../shared/contracts";

export type DeliveryRow = {
  processed_at: Date | string | null;
  incident_id: string | null;
  failure: string | null;
};

export const deliveryReceipt = (
  eventId: string,
  row: DeliveryRow,
  duplicate: boolean,
): EventReceipt => {
  if (row.processed_at)
    return {
      eventId,
      duplicate,
      status: "processed",
      incidentId: row.incident_id,
    };
  if (row.failure)
    return {
      eventId,
      duplicate,
      status: "failed",
      incidentId: row.incident_id,
      error: row.failure,
    };
  return { eventId, duplicate, status: "queued", incidentId: null };
};
