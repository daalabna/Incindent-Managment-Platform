import type { PublicIncident } from "../../../../shared/domain";
import { useIncidentTimeline } from "../../../client/api";
import { IncidentAnalysis } from "./analysis/IncidentAnalysis";
import { IncidentActions } from "./IncidentActions";
import { IncidentCommentForm } from "./IncidentCommentForm";
import { IncidentHeader } from "./IncidentHeader";
import { IncidentMeta } from "./IncidentMeta";
import { IncidentTimeline } from "./IncidentTimeline";
import { useIncidentUpdate } from "./useIncidentUpdate";

export const IncidentBody = ({
  incident,
  close,
}: {
  incident: PublicIncident;
  close: () => void;
}) => {
  const timelineQuery = useIncidentTimeline(incident.id);
  const { comment, setComment, update } = useIncidentUpdate(incident);
  return (
    <>
      <IncidentHeader incident={incident} close={close} />
      <IncidentMeta incident={incident} />
      <IncidentActions
        incident={incident}
        pending={update.isPending}
        error={update.error?.message}
        onAssign={() => update.mutate({ assignMe: true })}
        onStatus={(status) => update.mutate({ status })}
      />
      <IncidentAnalysis
        key={incident.id}
        id={incident.id}
        version={incident.version}
      />
      <IncidentTimeline query={timelineQuery} />
      <IncidentCommentForm
        comment={comment}
        pending={update.isPending}
        onChange={setComment}
        onSubmit={(text) => update.mutate({ comment: text })}
      />
    </>
  );
};
