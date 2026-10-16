import type { Summary } from "../../../shared/domain";
import { HealthBanner } from "../features/overview/HealthBanner";
import { OverviewFooter } from "../features/overview/OverviewFooter";
import { OverviewStats } from "../features/overview/OverviewStats";
import { ServiceHealthSection } from "../features/overview/ServiceHealthSection";

export { OverviewFooter };

export const OverviewPage = ({
  data,
  healthy,
  activeCount,
  onServices,
}: {
  data: Summary;
  healthy: number;
  activeCount: number;
  onServices: () => void;
}) => {
  const active = data.incidents.filter(
    (incident) => incident.status !== "resolved",
  );
  return (
    <>
      <HealthBanner
        healthy={healthy}
        total={data.services.length}
        activeCount={activeCount}
      />
      <OverviewStats
        active={active}
        activeCount={activeCount}
        healthy={healthy}
        serviceCount={data.services.length}
        resolvedCount={data.resolvedCount}
        eventCount={data.eventCount}
      />
      <ServiceHealthSection services={data.services} onServices={onServices} />
    </>
  );
};
