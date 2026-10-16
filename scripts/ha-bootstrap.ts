import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const env = Object.fromEntries(
  readFileSync(".secrets/ha.env", "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const n = line.indexOf("=");
      return [line.slice(0, n), line.slice(n + 1)];
    }),
);
for (const service of ["api-a", "api-b"]) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      ".secrets/ha.env",
      "-f",
      "compose.ha.yaml",
      "exec",
      "-T",
      "-e",
      "ADMIN_USERNAME",
      "-e",
      "ADMIN_PASSWORD",
      service,
      "npm",
      "run",
      "user:create",
    ],
    {
      env: {
        ...process.env,
        ADMIN_USERNAME: env.ADMIN_USERNAME,
        ADMIN_PASSWORD: env.ADMIN_PASSWORD,
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.status !== 0) throw new Error(`Bootstrap failed for ${service}`);
}
