import { Activity, CheckCircle2, Server, TriangleAlert } from "lucide-react";
import type { PublicIncidentSummary } from "../../../../shared/domain";
import { Stat } from "./Stat";

export const OverviewStats = ({
  active,
  activeCount,
  healthy,
  serviceCount,
  resolvedCount,
  eventCount,
}: {
  active: PublicIncidentSummary[];
  activeCount: number;
  healthy: number;
  serviceCount: number;
  resolvedCount: number;
  eventCount: number;
}) => {
  const critical = active.filter(
    (incident) => incident.severity === "P1",
  ).length;
  return (
    <div className="stats-grid">
      <Stat
        label="Active incidents"
        value={activeCount}
        icon={<TriangleAlert size={18} />}
        foot={`${critical} critical · ${activeCount - critical} other`}
        warning={activeCount > 0}
      />
      <Stat
        label="Healthy services"
        value={`${healthy}/${serviceCount}`}
        icon={<Server size={18} />}
        foot="Across your local environment"
      />
      <Stat
        label="Resolved incidents"
        value={resolvedCount}
        icon={<CheckCircle2 size={18} />}
        foot="Since workspace creation"
      />
      <Stat
        label="Events received"
        value={eventCount}
        icon={<Activity size={18} />}
        foot="Accepted monitoring signals"
      />
    </div>
  );
};
