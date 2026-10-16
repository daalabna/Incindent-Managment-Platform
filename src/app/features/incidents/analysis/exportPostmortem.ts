import type { AnalysisJob } from "../../../../../shared/ai";

export const exportPostmortem = (job: AnalysisJob) => {
  if (!job.result) return;
  const pm = job.result.postmortem;
  const cite = (item: { text: string; sources: string[] }) =>
    `${item.text} ${item.sources
      .map((id) => {
        const index = job.sources.findIndex((source) => source.id === id);
        return index < 0 ? "[удалён]" : `[${index + 1}]`;
      })
      .join(" ")}`;
  const content = [
    `# ${job.incidentId} — черновик postmortem`,
    "",
    "AI-черновик. Требует проверки оператором.",
    `Версия инцидента: ${job.incidentVersion}. ${job.stale ? "Контекст изменился: анализ устарел." : ""}`,
    "",
    "## Влияние",
    cite(pm.impact),
    "",
    "## Хронология",
    ...pm.timeline.map((x) => `- ${cite(x)}`),
    "",
    "## Причина / неопределённость",
    cite(pm.rootCause),
    job.result.statuses
      ? `Статус: ${job.result.statuses.rootCause === "observed" ? "observed" : "unconfirmed"}`
      : "",
    "",
    "## Выполненные действия",
    ...pm.actionsTaken.map((x) => `- ${cite(x)}`),
    "",
    "## Предложения",
    ...pm.prevention.map((x) => `- ${cite(x)}`),
    "",
    "## Ограничения",
    ...job.limitations.map((x) => `- ${x}`),
    ...job.result.missingData.map((x) => `- ${x}`),
    "",
    "## Источники",
    ...job.sources.map((s, i) => `[${i + 1}] ${s.label}\n${s.text}\n`),
  ].join("\n");
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${job.incidentId}-postmortem-draft.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
