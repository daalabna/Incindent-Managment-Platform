import type { PublicIncident } from "../../../../shared/domain";

export const IncidentMeta = ({ incident }: { incident: PublicIncident }) => (
  <div className="detail-grid">
    <div>
      <small>Service</small>
      <strong>{incident.serviceId}</strong>
    </div>
    <div>
      <small>Correlated alerts</small>
      <strong>{incident.alerts}</strong>
    </div>
    <div>
      <small>Assignee</small>
      <strong>{incident.assignee ?? "Unassigned"}</strong>
    </div>
    <div>
      <small>Version</small>
      <strong>v{incident.version}</strong>
    </div>
  </div>
);
