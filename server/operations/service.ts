import { randomUUID } from "node:crypto";
import type { PostgresStore } from "../db/postgres";
import { addDependency } from "../db/event-time";
import { insertRunbook } from "../db/runbooks";
import { saveAudit } from "../db/postgres-write";
import { createAudit } from "../domain/apply";
import { runbookSchema, type RunbookDefinition } from "../../shared/operations";
import { startRun, cancelRun } from "./runbooks";
import { retain } from "./retention";

/** Each command owns its transaction, including mandatory audit entries. */
export class OperationsService {
  constructor(private readonly store: PostgresStore) {}

  addDependency = (serviceId: string, dependsOn: string, actor: string) =>
    this.store.transaction(async (client) => {
      await addDependency(client, serviceId, dependsOn);
      await saveAudit(client, [
        createAudit(`Dependency ${serviceId} -> ${dependsOn}`, actor),
      ]);
      return { message: "Dependency added" };
    });

  createRunbook = (input: RunbookDefinition, actor: string) => {
    const definition = runbookSchema.parse(input);
    const id = randomUUID();
    return this.store.transaction(async (client) => {
      await insertRunbook(client, id, definition);
      await saveAudit(client, [
        createAudit(`Runbook created: ${definition.name}`, actor),
      ]);
      return { id, ...definition };
    });
  };

  startRun = (runbookId: string, incidentId: string, actor: string) =>
    this.store.transaction((client) =>
      startRun(client, runbookId, incidentId, actor),
    );

  cancelRun = (id: string, version: number, actor: string) =>
    this.store.transaction((client) => cancelRun(client, id, version, actor));

  retain = (days: number, dryRun: boolean, actor: string) =>
    this.store.transaction((client) => retain(client, days, dryRun, actor));

  replay = (id: string, generation: number, actor: string, reason: string) =>
    this.store.replay(id, generation, actor, reason);
}
