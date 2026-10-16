import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { DomainState } from "../domain/domain";
import { saveRule } from "./postgres-write";
import { advisoryLockSql } from "./locks";

export const migrateDatabase = async (client: PoolClient) => {
  await client.query(advisoryLockSql("migrate"));
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  if (
    !(
      await client.query(
        "SELECT version FROM schema_migrations WHERE version=1",
      )
    ).rowCount
  ) {
    await client.query(
      readFileSync(
        new URL("./migrations/001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
    const seed = new DomainState().state;
    for (const service of seed.services)
      await client.query("INSERT INTO services(id,payload) VALUES($1,$2)", [
        service.id,
        service,
      ]);
    for (const rule of seed.rules) await saveRule(client, rule);
    await client.query("INSERT INTO schema_migrations(version) VALUES(1)");
  }
  if (
    !(
      await client.query(
        "SELECT version FROM schema_migrations WHERE version=2",
      )
    ).rowCount
  ) {
    await client.query(
      readFileSync(
        new URL("./migrations/002_platform.sql", import.meta.url),
        "utf8",
      ),
    );
    await client.query("INSERT INTO schema_migrations(version) VALUES(2)");
  }
  if (
    !(
      await client.query(
        "SELECT version FROM schema_migrations WHERE version=3",
      )
    ).rowCount
  ) {
    await client.query(
      readFileSync(new URL("./migrations/003_ai.sql", import.meta.url), "utf8"),
    );
    await client.query("INSERT INTO schema_migrations(version) VALUES(3)");
  }
  if (
    !(
      await client.query(
        "SELECT version FROM schema_migrations WHERE version=4",
      )
    ).rowCount
  ) {
    await client.query(
      readFileSync(
        new URL("./migrations/004_evidence.sql", import.meta.url),
        "utf8",
      ),
    );
    await client.query("INSERT INTO schema_migrations(version) VALUES(4)");
  }
  if (
    !(
      await client.query(
        "SELECT version FROM schema_migrations WHERE version=5",
      )
    ).rowCount
  ) {
    await client.query(
      readFileSync(
        new URL("./migrations/005_notification_lease.sql", import.meta.url),
        "utf8",
      ),
    );
    await client.query("INSERT INTO schema_migrations(version) VALUES(5)");
  }
  if (
    !(
      await client.query(
        "SELECT version FROM schema_migrations WHERE version=6",
      )
    ).rowCount
  ) {
    await client.query(
      readFileSync(
        new URL("./migrations/006_incident_timeline.sql", import.meta.url),
        "utf8",
      ),
    );
    await client.query("INSERT INTO schema_migrations(version) VALUES(6)");
  }
  if (
    !(
      await client.query(
        "SELECT version FROM schema_migrations WHERE version=7",
      )
    ).rowCount
  ) {
    await client.query(
      readFileSync(
        new URL("./migrations/007_timeline_payload_strip.sql", import.meta.url),
        "utf8",
      ),
    );
    await client.query("INSERT INTO schema_migrations(version) VALUES(7)");
  }
  if (
    !(
      await client.query(
        "SELECT version FROM schema_migrations WHERE version=8",
      )
    ).rowCount
  ) {
    await client.query(
      readFileSync(
        new URL("./migrations/008_notification_audit.sql", import.meta.url),
        "utf8",
      ),
    );
    await client.query("INSERT INTO schema_migrations(version) VALUES(8)");
  }
};
