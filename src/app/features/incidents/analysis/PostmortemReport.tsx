import { Download } from "lucide-react";
import type { AnalysisJob } from "../../../../../shared/ai";
import { exportPostmortem } from "./exportPostmortem";
import { Sources } from "./Sources";

type Report = NonNullable<AnalysisJob["result"]>;

export const PostmortemReport = ({
  job,
  report,
}: {
  job: AnalysisJob;
  report: Report;
}) => (
  <div className="ai-result">
    <p className="ai-stale">
      Черновик для проверки оператором. Не является подтверждённым заключением о
      причине.
    </p>
    <h4>Влияние</h4>
    <p>
      {report.postmortem.impact.text}{" "}
      <Sources ids={report.postmortem.impact.sources} job={job} />
    </p>
    <h4>Хронология</h4>
    <ol>
      {report.postmortem.timeline.map((entry, i) => (
        <li key={i}>
          {entry.text} <Sources ids={entry.sources} job={job} />
        </li>
      ))}
    </ol>
    <h4>Причина / неопределённость</h4>
    {report.statuses && (
      <p className="muted" role="status">
        Статус причины:{" "}
        {report.statuses.rootCause === "observed"
          ? "подтверждена измерениями"
          : "не подтверждена"}
      </p>
    )}
    <p>
      {report.postmortem.rootCause.text}{" "}
      <Sources ids={report.postmortem.rootCause.sources} job={job} />
    </p>
    <h4>Выполненные действия</h4>
    <ul>
      {report.postmortem.actionsTaken.map((entry, i) => (
        <li key={i}>
          {entry.text} <Sources ids={entry.sources} job={job} />
        </li>
      ))}
    </ul>
    <h4>Предложения по предотвращению</h4>
    <ul>
      {report.postmortem.prevention.map((item, i) => (
        <li key={i}>
          {item.text} <Sources ids={item.sources} job={job} />
        </li>
      ))}
    </ul>
    <button className="secondary" onClick={() => exportPostmortem(job)}>
      <Download size={14} /> Скачать черновик .md
    </button>
  </div>
);
