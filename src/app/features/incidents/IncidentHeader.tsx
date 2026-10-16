import { X } from "lucide-react";
import type { PublicIncident } from "../../../../shared/domain";
import { labels } from "../../lib/format";

export const IncidentHeader = ({
  incident,
  close,
}: {
  incident: PublicIncident;
  close: () => void;
}) => (
  <>
    <div className="drawer-top">
      <span>
        {incident.id} <span className="muted">/ Incident details</span>
      </span>
      <button
        className="icon-button"
        aria-label="Close incident"
        onClick={close}
      >
        <X size={20} />
      </button>
    </div>
    <h2 id="incident-heading">{incident.title}</h2>
    <div className="drawer-badges">
      <span className={`severity ${incident.severity}`}>
        {incident.severity}
      </span>
      <span className={`status ${incident.status}`}>
        <span className="dot" />
        {labels[incident.status]}
      </span>
    </div>
  </>
);
