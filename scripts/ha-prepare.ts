import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
mkdirSync(".secrets/tls", { recursive: true });
if (!existsSync(".secrets/ha.env")) {
  const keys = [
    "HA_POSTGRES_PASSWORD",
    "HA_TENANT_A_PASSWORD",
    "HA_TENANT_B_PASSWORD",
    "HA_RABBIT_PASSWORD",
    "HA_ERLANG_COOKIE",
    "ADMIN_PASSWORD",
  ];
  writeFileSync(
    ".secrets/ha.env",
    keys.map((key) => `${key}=${randomBytes(24).toString("hex")}`).join("\n") +
      "\nADMIN_USERNAME=admin\n",
    { mode: 0o600 },
  );
}
if (!existsSync(".secrets/tls/cert.pem")) {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${resolve(".secrets/tls")}:/certs`,
      "alpine/openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "30",
      "-keyout",
      "/certs/key.pem",
      "-out",
      "/certs/cert.pem",
      "-subj",
      "/CN=alpha.localhost",
      "-addext",
      "subjectAltName=DNS:alpha.localhost,DNS:beta.localhost,DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) throw new Error("Certificate generation failed");
}
console.log(
  "Prepared .secrets/ha.env and a 30-day local TLS certificate. Credentials were not printed.",
);
