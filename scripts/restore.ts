import { spawn } from "node:child_process";
import { schemaOwnerSql } from "../server/db/ownership";
import { createReadStream, realpathSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
const input = process.argv.find((value) => value.endsWith(".dump"));
if (!input) throw new Error("Pass a .dump file within backups/");
const file = realpathSync(input);
const root = realpathSync(resolve("backups"));
const rel = relative(root, file);
if (rel.startsWith("..") || rel.includes(":"))
  throw new Error("Restore source must be in backups/");
const ha = process.argv.includes("--ha");
const compose = ha
  ? ["compose", "--env-file", ".secrets/ha.env", "-f", "compose.ha.yaml"]
  : ["compose"];
const database = `sentinel_restore_${randomUUID().replaceAll("-", "")}`;
const command = (args: string[]) =>
  spawn("docker", [...compose, "exec", "-T", "postgres", ...args], {
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
const wait = (child: ReturnType<typeof command>) =>
  new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Restore command exited ${code}`)),
    );
  });
const create = command(["createdb", "-U", "sentinel", database]);
create.stdin!.end();
await wait(create);
const restore = command([
  "pg_restore",
  "-U",
  "sentinel",
  "--exit-on-error",
  "--no-owner",
  "--no-acl",
  "-d",
  database,
]);
await Promise.all([
  pipeline(createReadStream(file), restore.stdin!),
  wait(restore),
]);
const check = command([
  "psql",
  "-U",
  "sentinel",
  "-d",
  database,
  "-v",
  "ON_ERROR_STOP=1",
  "-c",
  "SELECT schemaname,count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') GROUP BY schemaname",
]);
check.stdin!.end();
await wait(check);
if (ha) {
  const grants = command([
    "psql",
    "-U",
    "sentinel",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tenant_a') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tenant_b') THEN
    RAISE EXCEPTION 'tenant_a and tenant_b must already exist; pg_dump does not include cluster roles';
  END IF;
END $$;
${schemaOwnerSql("tenant_alpha", "tenant_a")};
${schemaOwnerSql("tenant_beta", "tenant_b")};
REVOKE ALL ON SCHEMA tenant_alpha FROM tenant_b;
REVOKE ALL ON SCHEMA tenant_beta FROM tenant_a;`,
  ]);
  grants.stdin!.end();
  await wait(grants);
  const own = command([
    "psql",
    "-U",
    "sentinel",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "BEGIN; SET LOCAL ROLE tenant_a; ALTER TABLE tenant_alpha.services ADD COLUMN restore_owner_probe text; ALTER TABLE tenant_alpha.services DROP COLUMN restore_owner_probe; ROLLBACK;",
  ]);
  own.stdin!.end();
  await wait(own);
  const foreign = command([
    "psql",
    "-U",
    "sentinel",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `BEGIN; SET LOCAL ROLE tenant_b;
DO $iso$
BEGIN
  PERFORM count(*) FROM tenant_alpha.services;
  RAISE EXCEPTION 'tenant_b can read tenant_alpha';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
END;
$iso$;
ROLLBACK;`,
  ]);
  foreign.stdin!.end();
  await wait(foreign);
}
console.log(
  `Restored and inspected fresh database ${database}; existing databases unchanged.`,
);
if (ha)
  console.log(
    "Tenant ownership and cross-schema denial were checked. Create cluster roles before cutover on a new server, then point only that tenant DATABASE_URL at this database.",
  );
