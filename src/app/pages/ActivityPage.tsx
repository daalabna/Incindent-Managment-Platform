import { Clock3 } from "lucide-react";
import { ActivityRow } from "../components/ActivityRow";
import { useActivity } from "../../client/api";

export const ActivityPage = () => {
  const activity = useActivity(true);
  const entries = activity.data?.items ?? [];
  return (
    <section className="panel audit-panel">
      <div className="section-heading">
        <h2>Audit trail</h2>
        <span className="muted">
          Latest 300 entries · Local operator & system
        </span>
      </div>
      {activity.error ? (
        <div className="error-box">{activity.error.message}</div>
      ) : entries.length ? (
        entries.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} clock="absolute" />
        ))
      ) : (
        <div className="empty">
          <Clock3 size={30} />
          <h3>
            {activity.isPending ? "Loading activity…" : "No activity yet"}
          </h3>
          <p>Start a simulation or create an alert rule.</p>
        </div>
      )}
    </section>
  );
};
