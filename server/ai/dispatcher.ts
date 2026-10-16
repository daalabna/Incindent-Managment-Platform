import type { AiService } from "./service";
import { startPeriodicTask } from "../runtime/periodic-task";
export const startAiDispatcher = (
  ai: AiService,
  publish: (id: string) => Promise<void>,
  report: (text: string) => void,
) =>
  startPeriodicTask(
    () => ai.publishPending(publish),
    1000,
    () => report("AI dispatcher deferred; retrying."),
  );
