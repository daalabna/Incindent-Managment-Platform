import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { readConfig } from "../config";
import { PostgresStore } from "../db/postgres";
import { advisoryLockSql } from "../db/locks";
import type { Snapshot } from "../../shared/domain";

const textField = (value: unknown, key: string) => {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
    return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
};

const path = process.env.DATABASE_PATH ?? "data/sentinel.db";
if (!existsSync(path))
  throw new Error("SQLite file does not exist. No data was imported.");
const legacy = new DatabaseSync(path, { readOnly: true });
const store = new PostgresStore(readConfig().databaseUrl);
try {
  const row = legacy.prepare("SELECT payload FROM snapshot WHERE id=1").get();
  const payload = textField(row, "payload");
  if (!payload) throw new Error("SQLite snapshot is empty");
  const state: Snapshot = JSON.parse(payload);
  const eventIds = legacy
    .prepare("SELECT id FROM event_ids")
    .all()
    .flatMap((item) => {
      const id = textField(item, "id");
      return id ? [id] : [];
    });
  await store.migrate();
  await store.transaction(async (client) => {
    await client.query(advisoryLockSql("migrate"));
    await client.query(
      "LOCK TABLE services,rules,incidents,audit_entries,monitoring_events,event_outbox IN ACCESS EXCLUSIVE MODE",
    );
    const count = await client.query<{ total: string | number }>(
      "SELECT (SELECT count(*) FROM incidents)+(SELECT count(*) FROM monitoring_events)+(SELECT count(*) FROM audit_entries)+(SELECT count(*) FROM app_metadata WHERE key='sqlite_import') AS total",
    );
    const total = count.rows[0]?.total;
    if (total === undefined) throw new Error("Could not read the import guard");
    if (Number(total) > 0)
      throw new Error(
        "PostgreSQL already contains data or was imported before; nothing overwritten.",
      );
    for (const service of state.services)
      await client.query(
        "INSERT INTO services(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload",
        [service.id, service],
      );
    await client.query("DELETE FROM rules"); // Only pristine seeded rules, verified above under table locks.
    for (const rule of state.rules) await store.writeRule(client, rule);
    for (const incident of state.incidents)
      await store.writeIncident(client, incident);
    await store.writeAudit(client, state.audit);
    for (const event of [...state.events].reverse())
      await client.query(
        "INSERT INTO monitoring_events(id,service_id,payload,processed_at) VALUES($1,$2,$3,now())",
        [event.id, event.source, event],
      );
    for (const id of eventIds)
      await client.query(
        "INSERT INTO monitoring_events(id,processed_at) VALUES($1,now()) ON CONFLICT(id) DO NOTHING",
        [id],
      );
    const nextId =
      Math.max(
        1000,
        ...state.incidents
          .map((i) => Number(i.id.replace("INC-", "")))
          .filter(Number.isFinite),
      ) + 1;
    await client.query("SELECT setval('incident_number',$1,false)", [nextId]);
    await client.query(
      "INSERT INTO app_metadata(key,value) VALUES('sqlite_import',$1)",
      [new Date().toISOString()],
    );
  });
  console.info(
    `Imported ${state.incidents.length} incidents, ${state.rules.length} rules, ${state.audit.length} audit entries and ${eventIds.length} event IDs. Original SQLite file unchanged.`,
  );
} finally {
  legacy.close();
  await store.close();
}
