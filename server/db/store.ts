// Optional standalone adapter; the distributed runtime uses PostgresStore.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeService } from "../domain/apply";
import { DomainError } from "../domain/errors";
import { DomainState } from "../domain/domain";
import type { MonitoringEvent, Snapshot } from "../../shared/domain";
export { DomainError };
export class Store extends DomainState {
  db: DatabaseSync;
  constructor(path: string) {
    super();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS event_ids (id TEXT PRIMARY KEY);",
    );
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(event_ids)").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    if (!columns.has("source"))
      this.db.exec("ALTER TABLE event_ids ADD COLUMN source TEXT");
    if (!columns.has("type"))
      this.db.exec("ALTER TABLE event_ids ADD COLUMN type TEXT");
    if (!columns.has("value"))
      this.db.exec("ALTER TABLE event_ids ADD COLUMN value REAL");
    const row = this.db
      .prepare("SELECT payload FROM snapshot WHERE id=1")
      .get() as { payload: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.payload) as Snapshot;
      parsed.receptionSequence ??= 0;
      parsed.services = (parsed.services ?? []).map(normalizeService);
      this.state = parsed;
    }
    this.save();
  }
  save = () => {
    this.db
      .prepare(
        "INSERT INTO snapshot(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(JSON.stringify(this.state));
  };
  protected override claimEvent = (
    event: MonitoringEvent,
  ): "new" | "duplicate" => {
    const row = this.db
      .prepare("SELECT source, type, value FROM event_ids WHERE id=?")
      .get(event.id) as
      | { source: string | null; type: string | null; value: number | null }
      | undefined;
    if (row) {
      const known =
        row.source !== null && row.type !== null && row.value !== null;
      if (
        known &&
        (row.source !== event.source ||
          row.type !== event.type ||
          row.value !== event.value)
      )
        throw new DomainError(
          "Event ID already belongs to a different event",
          409,
        );
      return "duplicate";
    }
    this.db
      .prepare(
        "INSERT INTO event_ids(id, source, type, value) VALUES(?, ?, ?, ?)",
      )
      .run(event.id, event.source, event.type, event.value);
    return "new";
  };
  override transaction = <T>(fn: () => T): T => {
    const before = structuredClone(this.state);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.save();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.state = before;
      this.db.exec("ROLLBACK");
      throw error;
    }
  };
  close = () => {
    this.db.close();
  };
}
