import { analysisSchema } from "../../shared/ai";
import { citeLimitations, type AnalysisContext } from "./context";
import { validateAnalysis } from "./validate";

export const incompatibleMessage =
  "Сохранённый анализ записан в предыдущем формате. Текст не преобразован и источники к нему не добавлены. Запросите новый анализ.";

/** Set by retention when a usable result is kept after context purge. */
export const resultAttestedLimitation =
  "Результат проверен до удаления контекста.";

/**
 * Succeeded rows must parse, must not claim observed rootCause, and must pass
 * the current validator. Without retained context they are not reusable/current.
 */
export const storedResultUsable = (
  state: string,
  result: unknown,
  context?: AnalysisContext | null,
) => {
  if (state !== "succeeded") return true;
  const parsed = analysisSchema.safeParse(result);
  if (!parsed.success) return false;
  if (parsed.data.statuses?.rootCause === "observed") return false;
  if (!context) return false;
  try {
    validateAnalysis(parsed.data, citeLimitations(context));
    return true;
  } catch {
    return false;
  }
};
