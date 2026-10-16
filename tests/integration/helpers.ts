import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import type { MonitoringEvent } from "../../shared/domain";
import type { PostgresStore } from "../../server/db/postgres";

export const event = (
  patch: Partial<MonitoringEvent> = {},
): MonitoringEvent => ({
  id: randomUUID(),
  source: "search-api",
  type: "error_rate",
  value: 12.8,
  timestamp: new Date().toISOString(),
  ...patch,
});

export const processed = async (direct: PostgresStore, id: string) => {
  await vi.waitFor(
    async () => expect((await direct.eventStatus(id)).status).toBe("processed"),
    {
      timeout: 12000,
      interval: 100,
    },
  );
};
