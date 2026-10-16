import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { request } from "../../client/api";
import {
  dependencySchema,
  failedJobSchema,
  notificationRowSchema,
  operationPage,
  runbookRowSchema,
  runbookRunSchema,
} from "../../../shared/operations";
import { list, useOps } from "../features/operations/ui";
import { DependenciesCard } from "../features/operations/DependenciesCard";
import { FailedCard } from "../features/operations/FailedCard";
import { NotificationsCard } from "../features/operations/NotificationsCard";
import { RunbooksCard } from "../features/operations/RunbooksCard";
import { RunsCard } from "../features/operations/runs";

const result = z.record(z.unknown());

export const OperationsPage = () => {
  const [error, setError] = useState("");
  const cache = useQueryClient();
  const failed = useOps(
    "/failed-jobs?open=true",
    5000,
    operationPage(failedJobSchema),
  );
  const running = useOps(
    "/runbook-runs?state=running",
    3000,
    operationPage(runbookRunSchema),
  );
  const compensating = useOps(
    "/runbook-runs?state=compensating",
    3000,
    operationPage(runbookRunSchema),
  );
  const runs = useOps("/runbook-runs", 5000, operationPage(runbookRunSchema));
  const notifications = useOps(
    "/notifications",
    5000,
    operationPage(notificationRowSchema),
  );
  const books = useOps("/runbooks", 15000, operationPage(runbookRowSchema));
  const graph = useQuery({
    queryKey: ["operations", "graph"],
    queryFn: () =>
      request(
        "/dependencies",
        "GET",
        undefined,
        operationPage(dependencySchema),
      ),
  });
  const mutate = async (path: string, body: unknown) => {
    setError("");
    try {
      await request(path, "POST", body, result);
      await cache.invalidateQueries({ queryKey: ["operations"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    }
  };
  const active = [...list(running), ...list(compensating)];

  return (
    <section className="panel ops-panel">
      <div className="section-heading">
        <div>
          <h2>Operations</h2>
          <p className="muted">
            Delivery retries, dependencies, notifications and runbooks.
          </p>
        </div>
      </div>
      {(error || failed.error) && (
        <p className="error-box">
          {error || "Operations require PostgreSQL mode."}
        </p>
      )}
      <div className="ops-grid">
        <FailedCard rows={list(failed)} query={failed} mutate={mutate} />
        <DependenciesCard edges={graph.data?.items ?? []} mutate={mutate} />
        <RunbooksCard books={list(books)} query={books} mutate={mutate} />
        <RunsCard
          title="Active runbooks"
          meta={`${active.length} in flight`}
          empty="No running or compensating runs"
          runs={active}
          mutate={mutate}
          queries={[running, compensating]}
        />
        <RunsCard
          title="Runbook history"
          meta={`${list(runs).length} recent`}
          empty="No runbook history yet"
          runs={list(runs)}
          mutate={mutate}
          queries={[runs]}
        />
        <NotificationsCard notes={list(notifications)} query={notifications} />
      </div>
    </section>
  );
};
