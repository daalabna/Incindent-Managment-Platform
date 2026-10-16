import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/db/store";
it("restores incidents, audit and idempotency across restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "sentinel-test-"));
  const path = join(directory, "state.db");
  let store = new Store(path);
  try {
    const event = {
      id: "stable-id",
      source: "search-api",
      type: "error_rate" as const,
      value: 9,
      timestamp: new Date().toISOString(),
    };
    store.ingest(event);
    store.update("INC-1001", 1, { comment: "Persistent investigation note" });
    store.close();
    store = new Store(path);
    expect(store.state.incidents[0].timeline.at(-1)?.text).toBe(
      "Persistent investigation note",
    );
    expect(store.ingest(event)).toEqual({ duplicate: true });
    expect(store.state.incidents[0].alerts).toBe(1);
    expect(store.state.audit).toHaveLength(3);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});
