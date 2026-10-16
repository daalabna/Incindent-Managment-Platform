import { allowedHostsFromEnv } from "../http/hosts";

export type SecurityConfig = {
  authRequired: boolean;
  cookieSecure: boolean;
  trustedProxies: string[];
  allowedHosts: string[];
};

const parseList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** Fail fast on invalid security-related environment. */
export const readSecurityConfig = (
  env: NodeJS.ProcessEnv = process.env,
): SecurityConfig => {
  const parseFlag = (name: string, raw: string | undefined, unset: boolean) => {
    const flag = (raw ?? "").trim().toLowerCase();
    if (!flag) return unset;
    if (["true", "1", "yes"].includes(flag)) return true;
    if (["false", "0", "no"].includes(flag)) return false;
    throw new Error(`${name} must be true/false/1/0/yes/no, got: ${raw}`);
  };
  const authRequired = parseFlag("AUTH_REQUIRED", env.AUTH_REQUIRED, false);
  const cookieSecure = parseFlag("COOKIE_SECURE", env.COOKIE_SECURE, true);
  const trustedProxies = parseList(env.TRUSTED_PROXIES);
  if (
    trustedProxies.length > 1 &&
    trustedProxies.some((item) => item === "uniquelocal")
  )
    throw new Error(
      "TRUSTED_PROXIES: uniquelocal cannot be mixed with other entries",
    );
  const allowedHosts = allowedHostsFromEnv(env);
  return { authRequired, cookieSecure, trustedProxies, allowedHosts };
};

export const trustProxyOption = (proxies: string[]) => {
  if (proxies.length === 1 && proxies[0] === "uniquelocal")
    return "uniquelocal" as const;
  return proxies.length ? proxies : false;
};
