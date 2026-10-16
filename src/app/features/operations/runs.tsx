import { Terminal } from "lucide-react";
import { Card, Empty, More, when, type Mutate, type PageQuery } from "./ui";
export type RunRow = {
  id: string;
  incident_id: string;
  step: number;
  steps: number;
  state: string;
  error: string | null;
  version: number;
  available_at: string;
  deadline_at: string;
};

const row = (run: RunRow, mutate: Mutate) => (
  <div key={run.id} className="ops-row">
    <div className="ops-row-main">
      <strong>{run.incident_id}</strong>
      <span className={`ops-state ${run.state}`}>{run.state}</span>
      <span className="muted">
        step {Math.min(run.step + 1, run.steps)}/{run.steps} · due{" "}
        {when(run.available_at)} · deadline {when(run.deadline_at)}
      </span>
      {run.error ? <span className="ops-error">{run.error}</span> : null}
    </div>
    {run.state === "running" && (
      <button
        className="secondary"
        onClick={() =>
          void mutate(`/runbook-runs/${run.id}/cancel`, {
            version: run.version,
          })
        }
      >
        Cancel & compensate
      </button>
    )}
  </div>
);

export const RunsCard = ({
  title,
  meta,
  empty,
  runs,
  mutate,
  queries,
}: {
  title: string;
  meta: string;
  empty: string;
  runs: RunRow[];
  mutate: Mutate;
  queries: PageQuery[];
}) => (
  <Card wide icon={<Terminal size={18} />} title={title} meta={meta}>
    {runs.length ? runs.map((r) => row(r, mutate)) : <Empty label={empty} />}
    {queries.map((q, i) => (
      <More key={i} {...q} />
    ))}
  </Card>
);
