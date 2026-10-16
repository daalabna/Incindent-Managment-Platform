import type { AnalysisJob } from "../../../../../shared/ai";
import { sourceAnchor } from "./sourceAnchor";

export const Sources = ({ ids, job }: { ids: string[]; job: AnalysisJob }) => (
  <span className="ai-citations">
    {ids.map((id) => {
      const index = job.sources.findIndex((source) => source.id === id);
      if (index < 0) return <span key={id}>[удалён]</span>;
      return (
        <a
          key={id}
          href={`#${sourceAnchor(job, id)}`}
          aria-label={`Источник ${index + 1}`}
          onClick={() => {
            const element = document.getElementById(sourceAnchor(job, id));
            if (element instanceof HTMLDetailsElement) element.open = true;
          }}
        >
          [{index + 1}]
        </a>
      );
    })}
  </span>
);
