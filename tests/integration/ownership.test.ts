import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { applySchemaOwner } from "../../server/db/ownership";
import { createIsolated, withCleanup } from "../support/isolated-infra";

it("reassigns the migrated schema, including identity sequences, and writes as the new owner", async () => {
  const f = await createIsolated();
  const role = `owner_${randomUUID().replaceAll("-", "")}`;
  let createdRole = false;
  await withCleanup(
    async () => {
      const privileges = (
        await f.direct.pool.query<{
          rolsuper: boolean;
          rolcreaterole: boolean;
        }>(
          "SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user",
        )
      ).rows[0]!;
      if (!privileges.rolsuper && !privileges.rolcreaterole)
        throw new Error("CREATE ROLE is required to verify restore ownership");
      await f.direct.pool.query(`CREATE ROLE ${role} NOLOGIN`);
      createdRole = true;
      await applySchemaOwner(f.direct.pool, "public", role);
      const sequences = await f.direct.pool.query<{ owner: string }>(
        `SELECT pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'S'`,
      );
      expect(sequences.rows.length).toBeGreaterThan(1);
      expect(sequences.rows.every((row) => row.owner === role)).toBe(true);
      const client = await f.direct.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query("ALTER TABLE services ADD COLUMN probe text");
        await client.query(
          `INSERT INTO audit_entries(id, payload) VALUES('11111111-1111-4111-8111-111111111111', '{"text":"owner"}'::jsonb)`,
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
    async () => {
      if (createdRole) {
        await f.direct.pool
          .query(`REASSIGN OWNED BY ${role} TO current_user`)
          .catch(() => undefined);
        await f.direct.pool
          .query(`DROP OWNED BY ${role}`)
          .catch(() => undefined);
        await f.direct.pool.query(`DROP ROLE IF EXISTS ${role}`);
      }
      await f.dispose();
    },
  );
});
