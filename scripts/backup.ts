import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
const ha = process.argv.includes("--ha");
const compose = ha
  ? ["compose", "--env-file", ".secrets/ha.env", "-f", "compose.ha.yaml"]
  : ["compose"];
mkdirSync("backups", { recursive: true });
const file = resolve(
  "backups",
  `sentinel-${ha ? "ha" : "local"}-${new Date().toISOString().replaceAll(":", "-")}.dump`,
);
const child = spawn(
  "docker",
  [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "pg_dump",
    "-U",
    "sentinel",
    "-d",
    "sentinel",
    "-Fc",
  ],
  { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
);
const completion = new Promise<void>((resolve, reject) => {
  child.on("error", reject);
  child.on("close", (code) =>
    code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}`)),
  );
});
await Promise.all([
  pipeline(child.stdout, createWriteStream(file, { flags: "wx", mode: 0o600 })),
  completion,
]);
console.log(`Backup saved: ${file}`);
