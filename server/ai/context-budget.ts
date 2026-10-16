import type { Evidence } from "../../shared/ai";

export type Candidate = {
  kind: Exclude<Evidence["kind"], "limitation">;
  label: string;
  text: string;
};

const caps: Record<Exclude<Evidence["kind"], "limitation">, number> = {
  incident: 4000,
  event: 8000,
  timeline: 8000,
  service: 2500,
  rule: 4000,
  dependency: 2000,
};
const totalCap = 24000;
const secretKey = String.raw`(?:password|secret|token|api[_-]?key|apiKey)`;

/** Defense in depth only — not a DLP guarantee. */
export const redactEvidence = (text: string) =>
  text
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(
      new RegExp(`"(${secretKey})"\\s*:\\s*"(?:\\\\.|[^"\\\\])*"`, "gi"),
      '"$1":"[REDACTED]"',
    )
    .replace(
      new RegExp(`'(${secretKey})'\\s*:\\s*'(?:\\\\.|[^'\\\\])*'`, "gi"),
      "'$1':'[REDACTED]'",
    )
    .replace(
      new RegExp(
        `((?:${secretKey})\\s*[=:]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;}\\]]+)`,
        "gi",
      ),
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");

export const takeSources = (candidates: Candidate[], budget = totalCap) => {
  const used: Partial<Record<Evidence["kind"], number>> = {};
  const omitted: Partial<Record<Evidence["kind"], number>> = {};
  const sources: Evidence[] = [];
  let total = 0;
  let truncated = 0;
  let ordinal = 0;
  for (const candidate of candidates) {
    const label = redactEvidence(candidate.label).slice(0, 200);
    const raw = redactEvidence(candidate.text);
    const text = raw.slice(0, 1200);
    if (text.length < raw.length) truncated += 1;
    const cost = label.length + text.length;
    const room = Math.min(
      caps[candidate.kind] - (used[candidate.kind] ?? 0),
      budget - total,
    );
    if (cost > room) {
      omitted[candidate.kind] = (omitted[candidate.kind] ?? 0) + 1;
      continue;
    }
    ordinal += 1;
    used[candidate.kind] = (used[candidate.kind] ?? 0) + cost;
    total += cost;
    sources.push({
      id: `${candidate.kind}:${ordinal}`,
      kind: candidate.kind,
      label,
      text,
    });
  }
  return { sources, omitted, truncated };
};

export const limitationText = (
  omitted: Partial<Record<Evidence["kind"], number>>,
  truncated: number,
) => {
  const lines = [
    "Нет логов приложения, трассировок, истории деплоев и измерений бизнес-ущерба. Причина требует проверки.",
    "Контекст ограничен: инцидент, до 30 событий, 25 свежих записей timeline, 15 правил и 20 зависимостей. Общий бюджет 24000 символов.",
  ];
  const dropped = Object.entries(omitted).filter(
    (entry): entry is [string, number] => (entry[1] ?? 0) > 0,
  );
  if (dropped.length)
    lines.push(
      `Из-за бюджета не передано: ${dropped.map(([kind, count]) => `${kind} ${count}`).join(", ")}. Сначала сохранены измеренные события и более новые записи.`,
    );
  if (truncated)
    lines.push(`Обрезано записей длиннее 1200 символов: ${truncated}.`);
  return lines;
};
