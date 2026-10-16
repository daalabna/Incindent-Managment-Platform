import { AlertTriangle } from "lucide-react";
import { Card, Empty, More, text, type Mutate, type PageQuery } from "./ui";

export const FailedCard = ({
  rows,
  query,
  mutate,
}: {
  rows: { event_id: unknown; generation: unknown; reason: unknown }[];
  query: PageQuery;
  mutate: Mutate;
}) => (
  <Card
    icon={<AlertTriangle size={18} />}
    title="Open failed events"
    meta={`${rows.length} open`}
  >
    {rows.length === 0 ? (
      <Empty label="No open failed jobs" />
    ) : (
      rows.map((job) => (
        <div
          key={`${text(job.event_id)}:${text(job.generation)}`}
          className="ops-row"
        >
          <div className="ops-row-main">
            <strong>{text(job.event_id)}</strong>
            <span className="muted">gen {text(job.generation)}</span>
            <span className="ops-error">{text(job.reason)}</span>
          </div>
          <button
            className="secondary"
            onClick={() =>
              void mutate(
                `/failed-jobs/${encodeURIComponent(text(job.event_id))}/replay`,
                {
                  generation: job.generation,
                  reason: "Manual replay from Operations",
                },
              )
            }
          >
            Replay
          </button>
        </div>
      ))
    )}
    <More {...query} />
  </Card>
);
