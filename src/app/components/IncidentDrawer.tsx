import { X } from "lucide-react";
import { useIncident } from "../../client/api";
import { IncidentBody } from "../features/incidents/IncidentBody";
import { Dialog } from "./Dialog";

export const IncidentDrawer = ({
  id,
  close,
}: {
  id: string;
  close: () => void;
}) => {
  const incidentQuery = useIncident(id);
  const incident = incidentQuery.data;
  return (
    <Dialog close={close} labelledBy="incident-heading" className="drawer">
      {incident ? (
        <IncidentBody incident={incident} close={close} />
      ) : (
        <>
          <div className="drawer-top">
            <span>{id}</span>
            <button
              className="icon-button"
              aria-label="Close incident"
              onClick={close}
            >
              <X size={20} />
            </button>
          </div>
          <h2 id="incident-heading">Incident details</h2>
          <p className="muted">
            {incidentQuery.error
              ? incidentQuery.error.message
              : "Loading incident…"}
          </p>
        </>
      )}
    </Dialog>
  );
};
