import type { PostgresStore } from "../db/postgres";
import { formatError } from "../domain/errors";
import { startPeriodicTask } from "./periodic-task";

export const startDispatcher = (
  store: PostgresStore,
  publish: (id: string) => Promise<void>,
  ready: () => boolean,
  report: (message: string) => void,
) =>
  startPeriodicTask(
    async () => {
      for (const note of await store.publishPending(publish)) report(note);
    },
    250,
    (error) =>
      report(`Outbox dispatch deferred; retrying. ${formatError(error)}`),
    ready,
  );
