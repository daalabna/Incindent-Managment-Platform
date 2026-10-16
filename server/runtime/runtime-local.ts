import type { Runtime } from "./runtime-types";
import { changed } from "./runtime-types";
import { listIncidents, refreshServices, toSummary } from "../domain/apply";
import { DomainError } from "../domain/errors";
import { Store } from "../db/store";
import type { ChangeNotice } from "../broker/redis";
import { LOCAL_OPERATOR } from "../security/actors";

/** SQLite/in-memory runtime for unit tests and ALLOW_SQLITE demos only. */
export const localRuntime = (
  path: string,
  onChange: (notice: ChangeNotice) => void,
): Runtime => {
  const store = new Store(path);
  let lock = false;
  return {
    mode: "local",
    snapshot: async () => refreshServices(structuredClone(store.state)),
    summary: async () => toSummary(structuredClone(store.state)),
    incident: async (id) => {
      const incident = store.state.incidents.find((item) => item.id === id);
      if (!incident) throw new DomainError("Incident not found", 404);
      return structuredClone(incident);
    },
    incidents: async (limit, cursor, status, q) =>
      listIncidents(store.state, limit, cursor, status, q),
    activity: async (limit, offset = 0) => {
      const items = store.state.audit.slice(offset, offset + limit);
      return {
        items,
        nextOffset: items.length === limit ? offset + limit : null,
      };
    },
    ingest: async (event) => {
      const result = store.ingest(event);
      if (!result.duplicate) onChange(changed(result.incidentId));
      return result;
    },
    update: async (id, version, patch, actor = LOCAL_OPERATOR) => {
      const result = store.update(id, version, patch, actor);
      onChange(changed(result.id));
      return result;
    },
    addRule: async (rule, actor = LOCAL_OPERATOR) => {
      if (rule.windowSeconds)
        throw new DomainError("Event-time windows require PostgreSQL mode");
      const result = store.addRule(rule, actor);
      onChange(changed());
      return result;
    },
    toggleRule: async (id, enabled, actor = LOCAL_OPERATOR) => {
      const result = store.toggleRule(id, enabled, actor);
      onChange(changed());
      return result;
    },
    record: async (text, actor) => {
      store.transaction(() => store.record(text, actor));
      onChange(changed());
    },
    acquireSimulation: async () => {
      if (lock) return null;
      lock = true;
      return "local";
    },
    renewSimulation: async () => lock,
    releaseSimulation: async () => {
      lock = false;
    },
    health: async () => ({ status: "ok", mode: "local", storage: "sqlite" }),
    eventStatus: async () => {
      throw new DomainError(
        "Event delivery status is available in distributed mode",
        404,
      );
    },
    close: async () => {
      store.close();
    },
  };
};
