import { citeLimitations, type AnalysisContext } from "../../server/ai/context";
import type { AnalysisOutput } from "../../server/ai/provider";
export const fixtureAnalysis = (context: AnalysisContext): AnalysisOutput => {
  const cited = citeLimitations(context);
  const observation = cited.sources.find(
    (item) =>
      item.kind === "event" ||
      item.kind === "rule" ||
      item.kind === "dependency",
  );
  const limitation =
    cited.sources.find((item) => item.id === "limitations")?.id ??
    cited.sources[0]!.id;
  const fact = observation
    ? {
        text: `${observation.label}: ${observation.text}`,
        sources: [observation.id],
      }
    : {
        text: "Причина требует проверки: измеренные события в контексте отсутствуют.",
        sources: [limitation],
      };
  const meta = { text: "Причина не подтверждена.", sources: [limitation] };
  const check = observation
    ? {
        action: `Проверить ${observation.label}`,
        reason: `${observation.label}: ${observation.text}`,
        sources: [observation.id],
      }
    : {
        action: "Проверить доступные ограничения",
        reason: "Причина требует проверки.",
        sources: [limitation],
      };
  return {
    result: {
      summary: fact,
      facts: [fact],
      hypotheses: [],
      nextChecks: observation ? [check] : [],
      missingData: ["Нет логов приложения"],
      postmortem: {
        impact: fact,
        timeline: observation ? [fact] : [],
        rootCause: meta,
        actionsTaken: [],
        prevention: observation
          ? [
              {
                text: `${observation.label}: ${observation.text}`,
                sources: [observation.id],
              },
            ]
          : [],
      },
    },
    inputTokens: 100,
    outputTokens: 80,
    estimatedCostUsd: 0.000168,
  };
};
