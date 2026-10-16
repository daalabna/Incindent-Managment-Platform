import { ArrowRight } from "lucide-react";
import {
  transitions,
  type PublicIncident,
  type Status,
} from "../../../../shared/domain";

const actionLabel = (status: Status) =>
  status === "acknowledged"
    ? "Acknowledge"
    : status === "investigating"
      ? "Investigate"
      : status === "mitigated"
        ? "Mark mitigated"
        : "Resolve incident";

export const IncidentActions = ({
  incident,
  pending,
  error,
  onAssign,
  onStatus,
}: {
  incident: PublicIncident;
  pending: boolean;
  error?: string;
  onAssign: () => void;
  onStatus: (status: Status) => void;
}) => (
  <>
    <div className="drawer-actions">
      {!incident.assignee && (
        <button className="secondary" disabled={pending} onClick={onAssign}>
          Assign to me
        </button>
      )}
      {transitions[incident.status].map((status) => (
        <button
          key={status}
          className="primary"
          disabled={pending}
          onClick={() => onStatus(status)}
        >
          {actionLabel(status)}
          <ArrowRight size={14} />
        </button>
      ))}
    </div>
    {error && (
      <div role="alert" className="error-box">
        {error}
      </div>
    )}
  </>
);
