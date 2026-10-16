import type { AnalysisJob } from "../../../../../shared/ai";
import { sourceAnchor } from "./sourceAnchor";

type Report = NonNullable<AnalysisJob["result"]>;

export const AnalysisEvidence = ({
  job,
  report,
}: {
  job: AnalysisJob;
  report: Report;
}) => (
  <>
    <h4>Недостающие данные и ограничения</h4>
    <ul>
      {report.missingData.map((text, i) => (
        <li key={`m-${i}`}>
          {report.statuses?.missingData[i] === "gap"
            ? "Пробел: "
            : report.statuses?.missingData[i] === "limitation_ref"
              ? "Ограничение контекста: "
              : ""}
          {text}
        </li>
      ))}
      {job.limitations.map((text, i) => (
        <li key={`l-${i}`}>{text}</li>
      ))}
    </ul>
    <div className="ai-evidence">
      <h4>Источники ({job.sources.length})</h4>
      {job.sources.map((source, i) => (
        <details key={source.id} id={sourceAnchor(job, source.id)}>
          <summary>
            [{i + 1}] {source.kind} · {source.label}
          </summary>
          <pre>{source.text}</pre>
        </details>
      ))}
    </div>
    <p className="ai-metadata">
      {job.model} · v{job.incidentVersion} ·{" "}
      {job.durationMs === null
        ? "—"
        : `${(job.durationMs / 1000).toFixed(1)} с`}
      {" · "}
      {job.inputTokens ?? 0} / {job.outputTokens ?? 0} токенов
      {job.estimatedCostUsd !== null &&
        ` · оценка $${job.estimatedCostUsd.toFixed(4)}`}
    </p>
  </>
);
