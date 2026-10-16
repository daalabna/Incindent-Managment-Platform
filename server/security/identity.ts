import { AsyncLocalStorage } from "node:async_hooks";
import { LOCAL_OPERATOR } from "./actors";
export type Identity = {
  id: string;
  username: string;
  role: "viewer" | "operator" | "admin";
  csrf: string;
};
export const identityContext = new AsyncLocalStorage<Identity>();
/** Resolve actor at the HTTP/application boundary, then pass explicitly into domain ops. */
export const auditActor = () =>
  identityContext.getStore()?.username ?? LOCAL_OPERATOR;
