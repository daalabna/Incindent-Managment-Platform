import type { AnalysisJob } from "../../../../../shared/ai";

export const sourceAnchor = (job: AnalysisJob, id: string) =>
  `ai-${job.id}-${encodeURIComponent(id)}`;
