const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

const hostnameOf = (value: string) => {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 1 ? value.slice(1, end) : value;
  }
  const colon = value.lastIndexOf(":");
  if (
    colon > 0 &&
    value.indexOf(":") === colon &&
    /^\d+$/.test(value.slice(colon + 1))
  )
    return value.slice(0, colon);
  return value;
};

export const isAllowedHost = (
  value: string | undefined,
  extra: readonly string[] = [],
) => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (extra.some((entry) => entry.trim().toLowerCase() === normalized))
    return true;
  const hostname = hostnameOf(normalized);
  return LOOPBACK.has(hostname);
};

export const allowedHostsFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  (env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
