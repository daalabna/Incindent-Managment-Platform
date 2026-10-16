import { useState } from "react";
import { FileText, Sparkles } from "lucide-react";
import { AnalysisControls } from "./AnalysisControls";
import { AnalysisEvidence } from "./AnalysisEvidence";
import { AnalysisReport } from "./AnalysisReport";
import { AnalysisStatus } from "./AnalysisStatus";
import { PostmortemReport } from "./PostmortemReport";
import { useIncidentAnalysis } from "./useIncidentAnalysis";

export const IncidentAnalysis = ({
  id,
  version,
}: {
  id: string;
  version: number;
}) => {
  const [tab, setTab] = useState<"analysis" | "postmortem">("analysis");
  const { query, generate, job, busy, report, reusable } = useIncidentAnalysis(
    id,
    version,
  );
  return (
    <section className="ai-panel" aria-label="AI-помощник инцидента">
      <div className="ai-heading">
        <h3>
          <Sparkles size={18} /> AI-помощник
        </h3>
        <span className="ai-badge">По данным инцидента</span>
      </div>
      <p className="muted">
        Сводка, гипотезы и черновик postmortem с источниками. Решения остаются
        за оператором.
      </p>
      {query.error && (
        <p role="alert" className="error-box">
          {query.error.message}
        </p>
      )}
      <AnalysisControls
        enabled={query.data?.enabled}
        reason={query.data?.reason}
        busy={busy}
        reusable={reusable}
        hasReport={Boolean(report)}
        jobState={job?.state}
        onGenerate={() => generate.mutate()}
        generateError={generate.error?.message}
      />
      <AnalysisStatus job={job} busy={busy} />
      {job && report && (
        <>
          <div className="ai-tabs" role="group" aria-label="Раздел анализа">
            <button
              className={tab === "analysis" ? "primary" : "secondary"}
              aria-pressed={tab === "analysis"}
              onClick={() => setTab("analysis")}
            >
              AI-анализ
            </button>
            <button
              className={tab === "postmortem" ? "primary" : "secondary"}
              aria-pressed={tab === "postmortem"}
              onClick={() => setTab("postmortem")}
            >
              <FileText size={14} /> Черновик postmortem
            </button>
          </div>
          {tab === "analysis" ? (
            <AnalysisReport job={job} report={report} />
          ) : (
            <PostmortemReport job={job} report={report} />
          )}
          <AnalysisEvidence job={job} report={report} />
        </>
      )}
    </section>
  );
};
