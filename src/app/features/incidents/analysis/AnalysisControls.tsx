import { RefreshCw, Sparkles } from "lucide-react";
import { session } from "../../../../client/session";

export const AnalysisControls = ({
  enabled,
  reason,
  busy,
  reusable,
  hasReport,
  jobState,
  onGenerate,
  generateError,
}: {
  enabled: boolean | undefined;
  reason: string | null | undefined;
  busy: boolean;
  reusable: boolean;
  hasReport: boolean;
  jobState: string | undefined;
  onGenerate: () => void;
  generateError: string | undefined;
}) => (
  <>
    {enabled === false && reason ? <p className="muted">{reason}</p> : null}
    {enabled && (
      <>
        <p className="ai-disclosure">
          По кнопке ограниченная выборка событий и timeline отправляется в
          OpenAI. Не включайте секреты в комментарии.
        </p>
        <button
          className="secondary"
          disabled={busy || session.role === "viewer"}
          onClick={onGenerate}
        >
          {busy ? (
            <RefreshCw size={14} className="ai-spinning" />
          ) : (
            <Sparkles size={14} />
          )}
          {busy
            ? "Анализ выполняется…"
            : jobState === "failed" || jobState === "incompatible"
              ? "Повторить анализ"
              : reusable
                ? "Открыть сохранённый анализ"
                : hasReport
                  ? "Обновить анализ"
                  : "Проанализировать"}
        </button>
        {session.role === "viewer" && (
          <p className="muted">
            Запуск анализа доступен operator и admin. Сохранённый результат
            можно прочитать.
          </p>
        )}
      </>
    )}
    {generateError && (
      <p role="alert" className="error-box">
        {generateError}
      </p>
    )}
  </>
);
