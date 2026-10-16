import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  incidentSchema,
  type IncidentPatch,
} from "../../../../shared/contracts";
import type { PublicIncident } from "../../../../shared/domain";
import { request } from "../../../client/api";

export const useIncidentUpdate = (incident: PublicIncident) => {
  const cache = useQueryClient();
  const [comment, setComment] = useState("");
  const update = useMutation({
    mutationFn: (patch: IncidentPatch | { assignMe: true }) =>
      "assignMe" in patch
        ? request(
            `/incidents/${incident.id}/assign-me`,
            "POST",
            { version: incident.version },
            incidentSchema,
          )
        : request(
            `/incidents/${incident.id}`,
            "PATCH",
            { version: incident.version, ...patch },
            incidentSchema,
          ),
    onSuccess: (_result, patch) => {
      if (
        "comment" in patch &&
        patch.comment &&
        comment.trim() === patch.comment
      )
        setComment("");
      return Promise.all([
        cache.invalidateQueries({ queryKey: ["summary"] }),
        cache.invalidateQueries({ queryKey: ["incident", incident.id] }),
        cache.invalidateQueries({
          queryKey: ["incident-timeline", incident.id],
        }),
        cache.invalidateQueries({ queryKey: ["activity"] }),
      ]);
    },
    onError: () => {
      void cache.invalidateQueries({ queryKey: ["incident", incident.id] });
      void cache.invalidateQueries({ queryKey: ["summary"] });
    },
  });
  return { comment, setComment, update };
};
