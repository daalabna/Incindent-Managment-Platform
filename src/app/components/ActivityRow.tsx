import { Activity, GitBranch } from "lucide-react";
import type { AuditEntry } from "../../../shared/domain";
import { age, time } from "../lib/format";

export const ActivityRow = ({
  entry,
  clock,
}: {
  entry: AuditEntry;
  clock: "relative" | "absolute";
}) => {
  const Icon = clock === "relative" ? GitBranch : Activity;
  return (
    <div className="activity-row">
      <span className="activity-icon">
        <Icon size={clock === "relative" ? 15 : 16} />
      </span>
      <div>
        <strong>{entry.text}</strong>
        <small>
          {entry.actor}
          {entry.incidentId ? ` · ${entry.incidentId}` : ""}
        </small>
      </div>
      <time>{clock === "relative" ? age(entry.at) : time(entry.at)}</time>
    </div>
  );
};
