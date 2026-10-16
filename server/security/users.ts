import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PostgresStore } from "../db/postgres";
import { saveAudit } from "../db/postgres-write";
import { createAudit } from "../domain/apply";
import type { Identity } from "./identity";
import { passwordHash } from "./passwords";
import { SYSTEM_ACTOR } from "./actors";

export const createUser = async (
  store: PostgresStore,
  username: string,
  password: string,
  role: Identity["role"],
  actor = SYSTEM_ACTOR,
) => {
  z.string().min(12).max(256).parse(password);
  z.string().min(1).max(100).parse(username);
  z.enum(["viewer", "operator", "admin"]).parse(role);
  // CPU work does not hold a PostgreSQL connection or an open transaction.
  const hash = await passwordHash(password);
  const id = randomUUID();
  return store.transaction(async (client) => {
    await client.query(
      "INSERT INTO auth_users(id,username,password_hash,role) VALUES($1,$2,$3,$4)",
      [id, username, hash, role],
    );
    await saveAudit(client, [
      createAudit(`User created: ${username} (${role})`, actor),
    ]);
    return { id, username, role };
  });
};
