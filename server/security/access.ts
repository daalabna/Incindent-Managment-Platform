import type { FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors";
import type { Identity } from "./identity";

export const principals = new WeakMap<FastifyRequest, Identity>();

const adminRoots = [
  "/api/rules",
  "/api/dependencies",
  "/api/users",
  "/api/maintenance",
  "/api/failed-jobs",
];

export const requestPathname = (url: string) => {
  try {
    return new URL(url, "http://sentinel.local").pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
};

export const requiresAdministrator = (pathname: string) =>
  pathname === "/api/runbooks" ||
  pathname.startsWith("/api/runbooks/") ||
  adminRoots.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );

export const administrator = async (req: FastifyRequest) => {
  const role = principals.get(req)?.role;
  if (role && role !== "admin")
    throw new DomainError("Administrator role required", 403);
};
