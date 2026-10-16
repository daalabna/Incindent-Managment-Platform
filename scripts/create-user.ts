import { readConfig } from "../server/config";
import { PostgresStore } from "../server/db/postgres";
import { createUser } from "../server/security/auth";
import { z } from "zod";
const config = readConfig();
const store = new PostgresStore(config.databaseUrl, config.databaseSchema);
try {
  await store.migrate();
  const username = z.string().min(1).parse(process.env.ADMIN_USERNAME);
  const password = z.string().min(12).parse(process.env.ADMIN_PASSWORD);
  const role = z
    .enum(["admin", "operator", "viewer"])
    .parse(process.env.ADMIN_ROLE ?? "admin");
  const user = await createUser(store, username, password, role);
  console.log(
    `Created ${user.role} ${user.username} in tenant ${config.tenantId}`,
  );
} finally {
  await store.close();
}
