import { Bell } from "lucide-react";
import { Card, Empty, More, text, type PageQuery } from "./ui";

export const NotificationsCard = ({
  notes,
  query,
}: {
  notes: {
    id: unknown;
    incident_id: unknown;
    state: unknown;
    adapter: unknown;
    attempts: unknown;
    error: unknown;
  }[];
  query: PageQuery;
}) => (
  <Card
    wide
    icon={<Bell size={18} />}
    title="Notification journal"
    meta={`${notes.length} entries`}
  >
    {notes.length ? (
      notes.map((job) => (
        <div key={text(job.id)} className="ops-row">
          <div className="ops-row-main">
            <strong>{text(job.incident_id)}</strong>
            <span className={`ops-state ${text(job.state)}`}>
              {text(job.state) === "audit_pending"
                ? "Awaiting audit"
                : text(job.state)}
            </span>
            <span className="muted">{text(job.adapter)}</span>
            <span className="muted">attempts {text(job.attempts)}</span>
            {job.error ? (
              <span className="ops-error">{text(job.error)}</span>
            ) : null}
          </div>
        </div>
      ))
    ) : (
      <Empty label="No notification jobs recorded" />
    )}
    <More {...query} />
  </Card>
);
