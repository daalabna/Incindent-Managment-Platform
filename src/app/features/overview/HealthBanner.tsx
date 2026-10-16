import { CheckCircle2, Radio, TriangleAlert } from "lucide-react";

export const HealthBanner = ({
  healthy,
  total,
  activeCount,
}: {
  healthy: number;
  total: number;
  activeCount: number;
}) => {
  const allHealthy = healthy === total;
  return (
    <div className={`health-banner ${allHealthy ? "" : "warning"}`}>
      <span className="health-icon">
        {allHealthy ? <CheckCircle2 size={21} /> : <TriangleAlert size={21} />}
      </span>
      <div>
        <strong>
          {allHealthy
            ? "All systems operational"
            : "Some services need your attention"}
        </strong>
        <span>
          {healthy} of {total} services are healthy
          {activeCount
            ? ` · ${activeCount} active incident${activeCount > 1 ? "s" : ""}`
            : " · No active incidents"}
        </span>
      </div>
      <span className="live-tag">
        <Radio size={13} /> Live updates
      </span>
    </div>
  );
};
