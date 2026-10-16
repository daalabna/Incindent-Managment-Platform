import {
  modelAnalysisSchema,
  type Evidence,
  type IncidentAnalysis,
} from "../../shared/ai";
import type { AnalysisContext } from "./context";
import { assertClaimNumbers } from "./claim-numbers";
import {
  assertGroundedTokens,
  gapMissing,
  gapSmuggle,
  guardText,
  metaOnlyRoot,
  positiveMissing,
  rejectGuard,
} from "./guards";

export { AiFailure } from "./validate-errors";

/** Structured statuses derived server-side — not left to lexical regex alone. */
export type RootCauseStatus = "observed" | "unconfirmed";
export type MissingDataKind = "gap" | "limitation_ref";
export type AnalysisStatuses = {
  rootCause: RootCauseStatus;
  missingData: MissingDataKind[];
};

const measuredKind = new Set<Evidence["kind"]>([
  "event",
  "rule",
  "dependency",
  "limitation",
]);
const observationKind = new Set<Evidence["kind"]>([
  "event",
  "rule",
  "dependency",
]);
const reject = rejectGuard;

export const classifyMissingLine = (line: string): MissingDataKind =>
  gapMissing.test(line.trim()) ? "gap" : "limitation_ref";

export const classifyRootCause = (observed: boolean): RootCauseStatus =>
  observed ? "observed" : "unconfirmed";

export const analysisStatuses = (
  result: IncidentAnalysis,
  rootObserved: boolean,
): AnalysisStatuses => ({
  rootCause: classifyRootCause(rootObserved),
  missingData: result.missingData.map(classifyMissingLine),
});

/**
 * Contract + measured-source checks. Lexical guards are residual risk filters;
 * confirmed/gap meaning is carried by `statuses`.
 */
export const validateAnalysis = (value: unknown, context: AnalysisContext) => {
  // Idempotent: strip server-enriched statuses so provider → process-job re-entry works.
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            ([key]) => key !== "statuses",
          ),
        )
      : value;
  const result = modelAnalysisSchema.parse(raw);
  const known = new Set(context.sources.map((source) => source.id));
  const byId = new Map(context.sources.map((source) => [source.id, source]));
  const blobsOf = (ids: string[], kinds: Set<Evidence["kind"]>) =>
    ids.flatMap((id) => {
      const source = byId.get(id);
      return source && kinds.has(source.kind)
        ? [`${source.label}\n${source.text}`]
        : [];
    });
  const corpusOf = (ids: string[], kinds: Set<Evidence["kind"]>) =>
    blobsOf(ids, kinds).join("\n");
  const hasObservation = (ids: string[]) =>
    ids.some((id) => {
      const source = byId.get(id);
      return Boolean(source && observationKind.has(source.kind));
    });
  const refs = [
    result.summary,
    ...result.facts,
    ...result.nextChecks,
    result.postmortem.impact,
    ...result.postmortem.timeline,
    ...result.postmortem.actionsTaken,
    result.postmortem.rootCause,
    ...result.postmortem.prevention,
  ].flatMap((item) => item.sources);
  refs.push(...result.hypotheses.flatMap((item) => item.supportingSources));
  const missing = refs.find((id) => !known.has(id));
  if (missing)
    reject(
      `Модель сослалась на отсутствующий источник ${missing}. Анализ отклонён.`,
    );
  const requireMeasured = (ids: string[], label: string) => {
    const corpus = corpusOf(ids, measuredKind);
    if (!corpus.trim())
      reject(
        `${label} не опирается на измеренный источник (event/rule/dependency/limitation). Анализ отклонён.`,
      );
    return corpus;
  };
  const requireObservation = (ids: string[], label: string) => {
    const corpus = corpusOf(ids, observationKind);
    if (!corpus.trim())
      reject(
        `${label} не опирается на измерение (event/rule/dependency). Одного limitations недостаточно. Анализ отклонён.`,
      );
    return corpus;
  };
  const assertNums = (text: string, ids: string[], label: string) => {
    assertClaimNumbers(text, blobsOf(ids, observationKind), label);
  };
  for (const item of [
    result.summary,
    ...result.facts,
    result.postmortem.impact,
    ...result.postmortem.timeline,
    ...result.postmortem.actionsTaken,
  ]) {
    const corpus = requireObservation(item.sources, "Утверждение");
    assertNums(item.text, item.sources, "Утверждение");
    guardText(item.text, corpus);
    assertGroundedTokens(item.text, corpus);
  }
  for (const item of result.postmortem.prevention) {
    // Prevention is advice, not a measured claim — numbers + guardText only.
    const corpus = requireObservation(item.sources, "Утверждение");
    assertNums(item.text, item.sources, "Утверждение");
    guardText(item.text, corpus);
  }
  const root = result.postmortem.rootCause;
  // A reference is not proof of causation. Only an operator can confirm a cause.
  const rootObserved = false;
  if (hasObservation(root.sources)) {
    const corpus = requireObservation(root.sources, "Утверждение");
    assertNums(root.text, root.sources, "rootCause");
    if (!metaOnlyRoot.test(root.text.trim()))
      reject(
        "Причинный вывод нельзя помечать как подтверждённый измерениями. Используйте hypotheses или неподтверждённую формулировку. Анализ отклонён.",
      );
    guardText(root.text, corpus);
    assertGroundedTokens(root.text, corpus);
  } else {
    const corpus = corpusOf(root.sources, measuredKind);
    requireMeasured(root.sources, "Утверждение");
    if (/\d/.test(root.text))
      reject(
        "rootCause добавляет числа без измерения (event/rule/dependency). Одного limitations недостаточно. Анализ отклонён.",
      );
    if (!metaOnlyRoot.test(root.text.trim()))
      reject(
        "rootCause без измерения может только говорить о неподтверждённости или нехватке данных. Анализ отклонён.",
      );
    guardText(root.text, corpus);
    assertGroundedTokens(root.text, corpus);
  }
  for (const item of result.nextChecks) {
    // Recommendations are proposed actions, not measured facts.
    const corpus = requireObservation(item.sources, "Проверка");
    const blob = `${item.action}\n${item.reason}`;
    assertNums(blob, item.sources, "Проверка");
    guardText(item.action, corpus);
    guardText(item.reason, corpus);
  }
  for (const item of result.hypotheses) {
    const corpus = requireObservation(item.supportingSources, "Гипотеза");
    // verification is a proposed check (like nextChecks), not a measured claim.
    const claim = `${item.title}\n${item.explanation}\n${item.counterEvidence}`;
    assertNums(claim, item.supportingSources, "Гипотеза");
    assertNums(item.verification, item.supportingSources, "Гипотеза");
    guardText(claim, corpus);
    guardText(item.verification, corpus);
    assertGroundedTokens(claim, corpus);
  }
  const limitation = corpusOf(["limitations"], measuredKind);
  // NFKC so fullwidth ８ → 8; scrub budget boilerplate nums.
  const wholeNums = (value: string) =>
    new Set(
      [...value.normalize("NFKC").matchAll(/(?<![0-9])\d+(?![0-9])/g)].map(
        (hit) => hit[0]!,
      ),
    );
  const limitationNums = wholeNums(
    limitation
      .replace(/Контекст ограничен:[^\n]*/g, "")
      .replace(/Обрезано записей[^\n]*/g, "")
      .replace(/Из-за бюджета не передано:[^\n]*/g, ""),
  );
  const missingDamage =
    /поврежд|сломан|\bcorrupted\b|переполнен|memory\s+leak|root\s+cause\s+is|подтвержден[аоы](?![а-яё])|выш(?:ел|ла|ло|ли)\s+из\s+строя|из\s+строя|\bbroken\b|\bfailed\b|не\s+работает|неисправ/i;
  for (const line of result.missingData) {
    const trimmed = line.trim();
    const gap = gapMissing.test(trimmed);
    if (
      positiveMissing.test(trimmed) ||
      missingDamage.test(trimmed) ||
      (gap && gapSmuggle.test(trimmed))
    )
      reject(
        "missingData не должен утверждать воздействие или ущерб. Анализ отклонён.",
      );
    if (!gap) guardText(trimmed, limitation);
    for (const num of wholeNums(trimmed)) {
      if (!limitationNums.has(num))
        reject(
          "missingData добавляет число, которого нет в limitations. Анализ отклонён.",
        );
    }
  }
  if (
    /не подтвержден/i.test(root.text) &&
    /выявлен|установлен|доказан/i.test(root.text)
  )
    reject(
      "Неподтверждённая причина содержит вывод «выявлено» или «доказано». Анализ отклонён.",
    );
  return {
    ...result,
    statuses: analysisStatuses(result, rootObserved),
  };
};
