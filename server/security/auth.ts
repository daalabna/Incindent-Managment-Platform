import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PostgresStore } from "../db/postgres";
import type { RedisCoordinator } from "../broker/redis";
import { DomainError } from "../domain/errors";
import { identityContext, type Identity } from "./identity";
import { principals, requestPathname, requiresAdministrator } from "./access";
import { digest, registerAuthRoutes, sessionToken } from "./auth-routes";
import { readSecurityConfig } from "./config";
export { passwordHash } from "./passwords";
export { createUser } from "./users";
export {
  administrator,
  requiresAdministrator,
  requestPathname,
} from "./access";

export const installSecurity = async (
  app: FastifyInstance,
  store: PostgresStore,
  redis: RedisCoordinator,
  tenant: string,
) => {
  const security = readSecurityConfig();
  const cookieName = `sentinel_${tenant}`;
  const cookie = (token: string, age: number) =>
    `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${security.cookieSecure ? "; Secure" : ""}`;
  const bucketKey = (bucket: string) =>
    `${redis.channel}:rate:${bucket}:${Math.floor(Date.now() / 60000)}`;
  const sessionKey = (token: string) =>
    `${redis.channel}:session:${digest(token)}`;
  const allowSession = async (token: string, expiresAt: Date) => {
    const ttl = Math.max(
      1,
      Math.ceil((expiresAt.getTime() - Date.now()) / 1000),
    );
    await redis.client.set(sessionKey(token), "1", "EX", ttl);
  };
  const sessionAllowed = async (token: string) =>
    Boolean(await redis.client.get(sessionKey(token)));
  const loadSession = async (token: string) =>
    (
      await store.pool.query<Identity & { expires_at: Date }>(
        `SELECT u.id,u.username,u.role,s.csrf,s.expires_at FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now() AND NOT disabled`,
        [digest(token)],
      )
    ).rows[0];
  const level = async (bucket: string) =>
    Number((await redis.client.get(bucketKey(bucket))) ?? 0);
  const spend = async (
    reply: FastifyReply,
    bucket: string,
    max: number,
    mode: "open" | "closed" = "open",
  ) => {
    let count: unknown;
    try {
      count = await redis.client.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],120) end; return n",
        1,
        bucketKey(bucket),
      );
    } catch {
      if (mode === "open") return;
      reply.header("retry-after", "60");
      throw new DomainError("Rate limit unavailable", 503);
    }
    if (Number(count) > max) {
      reply.header("retry-after", "60");
      throw new DomainError("Rate limit exceeded", 429);
    }
  };
  const authorize = async (
    req: FastifyRequest,
    reply: FastifyReply,
    token: string,
    bearer: boolean,
    row: Identity & { expires_at: Date },
  ) => {
    await allowSession(token, row.expires_at).catch(() => undefined);
    // Fail-open: authenticated sessions stay usable if Redis rate counters are down.
    await spend(reply, `user:${row.id}`, 300, "open");
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (write && !bearer && req.headers["x-csrf-token"] !== row.csrf)
      throw new DomainError("CSRF check failed", 403);
    if (
      write &&
      row.role === "viewer" &&
      requestPathname(req.url) !== "/api/auth/logout"
    )
      throw new DomainError("Operator role required", 403);
    if (
      write &&
      requiresAdministrator(requestPathname(req.url)) &&
      row.role !== "admin"
    )
      throw new DomainError("Administrator role required", 403);
    principals.set(req, row);
  };
  app.addHook("onRequest", async (req, reply) => {
    const path = requestPathname(req.url);
    if (!path.startsWith("/api/") && !path.startsWith("/ws")) return;
    if (path === "/api/live") return;
    if (path === "/api/health") {
      await spend(reply, `health:${req.ip}`, 30, "closed");
      return;
    }
    const login = path === "/api/auth/login";
    if (login) {
      await spend(reply, `login:${req.ip}`, 10, "closed");
      return;
    }
    const { token, bearer } = sessionToken(req, cookieName);
    if (!token) {
      await spend(reply, `anon:${req.ip}`, 60, "closed");
      throw new DomainError("Authentication required", 401);
    }
    const capped = (await level(`authn:${req.ip}`).catch(() => 0)) >= 60;
    const allowlisted = await sessionAllowed(token).catch(() => false);
    if (capped && !allowlisted) {
      await spend(reply, `authn-fallback:${req.ip}`, 5, "closed");
      const row = await loadSession(token);
      if (!row) {
        reply.header("retry-after", "60");
        throw new DomainError("Rate limit exceeded", 429);
      }
      await authorize(req, reply, token, bearer, row);
      return;
    }
    const row = await loadSession(token);
    if (!row) {
      if (capped)
        await redis.client.del(sessionKey(token)).catch(() => undefined);
      else await spend(reply, `authn:${req.ip}`, 60, "closed");
      throw new DomainError("Session expired", 401);
    }
    await authorize(req, reply, token, bearer, row);
  });
  app.addHook("preHandler", (req, _reply, done) => {
    const identity = principals.get(req);
    if (identity) identityContext.run(identity, done);
    else done();
  });
  registerAuthRoutes(app, store, redis, tenant, {
    cookieName,
    cookie,
    sessionKey,
    allowSession,
  });
  return async (req: FastifyRequest) => {
    const { token } = sessionToken(req, cookieName);
    if (!token) return false;
    return Boolean(
      (
        await store.pool.query(
          "SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now() AND NOT disabled",
          [digest(token)],
        )
      ).rowCount,
    );
  };
};
