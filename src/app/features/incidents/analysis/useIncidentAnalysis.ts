import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  analysisJobSchema,
  analysisResponseSchema,
} from "../../../../../shared/ai";
import { request } from "../../../../client/api";

export const useIncidentAnalysis = (id: string, version: number) => {
  const cache = useQueryClient();
  const queryKey = ["analysis", id, version];
  const query = useQuery({
    queryKey,
    queryFn: () =>
      request(
        `/incidents/${encodeURIComponent(id)}/analysis`,
        "GET",
        undefined,
        analysisResponseSchema,
      ),
    refetchInterval: (q) =>
      ["queued", "running"].includes(q.state.data?.job?.state ?? "")
        ? 2000
        : 15000,
  });
  const generate = useMutation({
    mutationFn: () =>
      request(
        `/incidents/${encodeURIComponent(id)}/analysis`,
        "POST",
        { version },
        analysisJobSchema,
      ),
    onSuccess: (job) => {
      cache.setQueryData(queryKey, { enabled: true, reason: null, job });
    },
  });
  const job = query.data?.job;
  const busy =
    generate.isPending || job?.state === "queued" || job?.state === "running";
  const report = job?.result;
  const reusable =
    job?.state === "succeeded" && job.contextRetained && !job.stale;
  return { query, generate, job, busy, report, reusable };
};
