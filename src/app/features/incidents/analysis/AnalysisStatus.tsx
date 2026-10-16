import type { AnalysisJob } from "../../../../../shared/ai";

export const AnalysisStatus = ({
  job,
  busy,
}: {
  job: AnalysisJob | null | undefined;
  busy: boolean;
}) => (
  <>
    {job?.state === "failed" && (
      <p role="alert" className="error-box">
        {job.error} Повторный запрос доступен через минуту после предыдущего.
      </p>
    )}
    {job?.state === "incompatible" && (
      <p role="alert" className="error-box">
        {job.error}
      </p>
    )}
    {job?.state === "succeeded" && !job.contextRetained && (
      <p className="ai-stale" role="status">
        Источники удалены политикой хранения. Текст результата сохранён,
        повторно он не используется.
      </p>
    )}
    {busy && (
      <p role="status" className="muted">
        {job?.state === "queued"
          ? "Задача в очереди. Можно закрыть карточку — результат сохранится."
          : "Проверяем события и готовим черновик…"}
      </p>
    )}
    {job?.stale && (
      <p className="ai-stale" role="status">
        Данные изменились. Этот анализ относится к предыдущему контексту (v
        {job.incidentVersion}).
      </p>
    )}
  </>
);
