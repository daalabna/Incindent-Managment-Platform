import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PostgresStore } from "../db/postgres";
import type { RedisCoordinator } from "../broker/redis";
import { createAudit } from "../domain/apply";
import { saveAudit } from "../db/postgres-write";
import { DomainError } from "../domain/errors";
import type { Identity } from "./identity";
import { passwordHash, passwordMatches } from "./passwords";
import { createUser } from "./users";
import { principals } from "./access";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const sessionToken = (req: FastifyRequest, cookieName: string) => {
  const bearer = req.headers.authorization;
  if (bearer?.startsWith("Bearer "))
    return { token: bearer.slice(7), bearer: true };
  const cookie = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  return { token: cookie?.slice(cookieName.length + 1), bearer: false };
};

type SessionHelpers = {
  cookieName: string;
  cookie: (token: string, age: number) => string;
  sessionKey: (token: string) => string;
  allowSession: (token: string, expiresAt: Date) => Promise<void>;
};

export const registerAuthRoutes = (
  app: FastifyInstance,
  store: PostgresStore,
  redis: RedisCoordinator,
  tenant: string,
  helpers: SessionHelpers,
) => {
  const { cookieName, cookie, sessionKey, allowSession } = helpers;
  app.post("/api/auth/login", async (req, reply) => {
    const { username, password } = z
      .object({
        username: z.string().min(1).max(100),
        password: z.string().min(1).max(256),
      })
      .parse(req.body);
    const dummy = await passwordHash(randomBytes(32).toString("hex"));
    const user = (
      await store.pool.query<Identity & { password_hash: string }>(
        "SELECT id,username,role,password_hash FROM auth_users WHERE username=$1 AND NOT disabled",
        [username],
      )
    ).rows[0];
    const valid = await passwordMatches(password, user?.password_hash ?? dummy);
    if (!user || !valid) throw new DomainError("Invalid credentials", 401);
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const dropSession = async () => {
      await store.pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
        digest(token),
      ]);
      await redis.client.del(sessionKey(token)).catch(() => undefined);
    };
    const created = await store.transaction(async (client) => {
      await client.query("DELETE FROM auth_sessions WHERE expires_at<now()");
      return (
        await client.query<{ expires_at: Date }>(
          "INSERT INTO auth_sessions(token_hash,user_id,expires_at,csrf) VALUES($1,$2,now()+interval '8 hours',$3) RETURNING expires_at",
          [digest(token), user.id, csrf],
        )
      ).rows[0];
    });
    try {
      if (created) await allowSession(token, created.expires_at);
    } catch {
      await dropSession();
      throw new DomainError("Session cache unavailable", 503);
    }
    try {
      await store.transaction((client) =>
        saveAudit(client, [createAudit(`Login: ${username}`, username)]),
      );
    } catch (error) {
      await dropSession();
      throw error;
    }
    reply.header("set-cookie", cookie(token, 28800));
    return { username: user.username, role: user.role, tenant, csrf };
  });
  app.get("/api/auth/me", async (req) => ({ ...principals.get(req), tenant }));
  app.post("/api/auth/logout", async (req, reply) => {
    const { token } = sessionToken(req, cookieName);
    if (token) {
      await store.pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
        digest(token),
      ]);
      await redis.client.del(sessionKey(token)).catch(() => undefined);
    }
    reply.header("set-cookie", cookie("", 0));
    return { message: "Signed out" };
  });
  app.post("/api/users", async (req) => {
    const input = z
      .object({
        username: z.string(),
        password: z.string(),
        role: z.enum(["viewer", "operator", "admin"]),
      })
      .parse(req.body);
    const actor = principals.get(req)!.username;
    return createUser(store, input.username, input.password, input.role, actor);
  });
};

export { digest };
