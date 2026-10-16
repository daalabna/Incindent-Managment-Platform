import type { PostgresStore } from "../db/postgres";
import { idleTick } from "../db/idle-watermark";
import { notificationTick } from "./notifications";
import { runbookTick } from "./runbooks";
import { startPeriodicTask } from "../runtime/periodic-task";

export const startOperations = (
  report: (message: string) => void,
  ticks: Array<() => Promise<unknown>>,
  intervalMs = 500,
) => {
  const tasks = ticks.map((tick) =>
    startPeriodicTask(tick, intervalMs, (error) =>
      report(
        `Operations deferred: ${error instanceof Error ? error.message : "unknown error"}`,
      ),
    ),
  );
  return {
    stop: async () => {
      await Promise.all(tasks.map((task) => task.stop()));
    },
  };
};

export const startBackground = (
  store: PostgresStore,
  report: (message: string) => void,
) =>
  startOperations(report, [
    () => notificationTick(store),
    () => runbookTick(store),
    () => idleTick(store),
  ]);
