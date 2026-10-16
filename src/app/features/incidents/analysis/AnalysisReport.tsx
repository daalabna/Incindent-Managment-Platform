import type { AnalysisJob } from "../../../../../shared/ai";
import { Sources } from "./Sources";

type Report = NonNullable<AnalysisJob["result"]>;

export const AnalysisReport = ({
  job,
  report,
}: {
  job: AnalysisJob;
  report: Report;
}) => (
  <div className="ai-result">
    <h4>Сводка</h4>
    <p>
      {report.summary.text} <Sources ids={report.summary.sources} job={job} />
    </p>
    <h4>Факты по источникам</h4>
    <ul>
      {report.facts.map((fact, i) => (
        <li key={i}>
          {fact.text} <Sources ids={fact.sources} job={job} />
        </li>
      ))}
    </ul>
    <h4>Гипотезы — требуют проверки</h4>
    {!report.hypotheses.length && (
      <p>Недостаточно данных для обоснованной гипотезы.</p>
    )}
    {report.hypotheses.map((hypothesis, i) => (
      <article className="ai-hypothesis" key={i}>
        <strong>{hypothesis.title}</strong>
        <p>
          {hypothesis.explanation}{" "}
          <Sources ids={hypothesis.supportingSources} job={job} />
        </p>
        <p>
          <b>Ограничения:</b> {hypothesis.counterEvidence}
        </p>
        <p>
          <b>Проверка:</b> {hypothesis.verification}
        </p>
      </article>
    ))}
    <h4>Следующие проверки</h4>
    <ol>
      {report.nextChecks.map((check, i) => (
        <li key={i}>
          <strong>{check.action}</strong>
          <p>
            {check.reason} <Sources ids={check.sources} job={job} />
          </p>
        </li>
      ))}
    </ol>
  </div>
);
