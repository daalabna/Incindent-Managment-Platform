import {
  hasMilliseconds,
  supportsMilliseconds,
  numsForClaim,
  numsOf,
  rejectGuard,
} from "./guards";

const reject = rejectGuard;
const timestamp =
  /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?\b/g;
/** Short RU word-numerals slip past digit `numsOf` and len&lt;4 `tokensOf`. */
const wordNum =
  /(?<![\p{L}\p{N}])(?:ноль|нуль|один|одна|одно|два|две|три|оба|обе|ста|сто|тыс|тысяч\w*|млн|миллион\w*|млрд|миллиард\w*)(?![\p{L}\p{N}])/iu;
const errorRateRe =
  /\berror_rate\b|\berror[-\s]?rate\b|\berrorRate\b|частот[а-яё]+|ошиб[а-яё]*\s+частот/i;
const metricOf = (text: string) => {
  const found: string[] = [];
  if (/задержк|\blatency\b/i.test(text)) found.push("latency");
  if (errorRateRe.test(text)) found.push("error_rate");
  return found;
};
const isLatency = (blob: string) =>
  /задержк|\blatency\b|"type"\s*:\s*"latency"|"metric"\s*:\s*"latency"/i.test(
    blob,
  );
const isErrorRate = (blob: string) =>
  /\berror_rate\b|"type"\s*:\s*"error_rate"|"metric"\s*:\s*"error_rate"|\berror[-\s]?rate\b|\berrorRate\b|частот[а-яё]+|ошиб[а-яё]*\s+частот/i.test(
    blob,
  );
const sourceHasAllMetrics = (blob: string, metrics: string[]) =>
  metrics.every((metric) =>
    metric === "latency" ? isLatency(blob) : isErrorRate(blob),
  );

const allowNum = (
  num: string,
  clause: string,
  metrics: string[],
  blobs: string[],
  label: string,
) => {
  if (
    hasMilliseconds(clause) &&
    ((metrics.includes("error_rate") && !metrics.includes("latency")) ||
      (metrics.includes("latency") &&
        !blobs.some((blob) => isLatency(blob) && supportsMilliseconds(blob))))
  )
    reject(
      `${label} использует миллисекунды без соответствующего измерения времени.`,
    );
  if (!metrics.length && blobs.length > 1) {
    const allowed = blobs
      .map((blob) => numsForClaim(blob, clause))
      .reduce<Set<string> | null>((acc, set) => {
        if (!acc) return new Set(set);
        return new Set([...acc].filter((n) => set.has(n)));
      }, null);
    if (!allowed?.has(num))
      reject(
        `${label} добавляет число ${num}, которого нет в соответствующем поле источника. Анализ отклонён.`,
      );
    return;
  }
  const ok = blobs.some(
    (blob) =>
      sourceHasAllMetrics(blob, metrics) && numsForClaim(blob, clause).has(num),
  );
  if (!ok)
    reject(
      `${label} добавляет число ${num}, которого нет в соответствующем поле источника. Анализ отклонён.`,
    );
};

/** Soft gaps keep pending; sentence ends reset. Deferred pending if later clause owns metric. */
export const assertClaimNumbers = (
  text: string,
  corpora: string[],
  label: string,
) => {
  const joined = corpora.join("\n");
  const dates = new Set(joined.match(timestamp) ?? []);
  const withoutDates = text.replace(timestamp, (date) => {
    if (!dates.has(date))
      reject(`${label} добавляет дату ${date}, которой нет в источнике.`);
    return " ";
  });
  if (wordNum.test(withoutDates))
    reject(
      `${label} использует словесное число без опоры на измерение. Анализ отклонён.`,
    );
  const blobs = corpora.map((blob) => blob.replace(timestamp, " "));
  // NFKC so fullwidth ！？；． become ASCII terminators.
  const normalized = withoutDates.normalize("NFKC");
  // Space or letter after terminator (`1!Частота`); not `1.5`.
  const sentences = normalized.split(/(?<=[.;!?…。¡¿‽])(?:\s+|(?=[\p{L}]))/u);
  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    let pending: string[] = [];
    const clauses = sentence.split(
      /(?<!\d),|,(?!\d)|[\n\u2028\u2029\u0085]+|\s+(?:и|а|но|или|or|and|but)\s+|\s+[|/&+—–→·•]\s+/iu,
    );
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i]!;
      if (!clause.trim()) continue;
      const local = metricOf(clause);
      const nums = numsOf(clause);
      if (!nums.length) {
        if (local.length) pending = [...new Set([...pending, ...local])];
        continue;
      }
      const laterWithNums = new Set<string>();
      let laterNum = false;
      for (let j = i + 1; j < clauses.length; j++) {
        const next = clauses[j]!;
        if (!next.trim()) continue;
        if (numsOf(next).length) {
          laterNum = true;
          for (const m of metricOf(next)) laterWithNums.add(m);
        }
      }
      const ahead: string[] = [];
      if (!laterNum) {
        for (let j = i + 1; j < clauses.length; j++) {
          const next = clauses[j]!;
          if (!next.trim()) continue;
          ahead.push(...metricOf(next));
        }
      }
      const carried = pending.filter((m) => !laterWithNums.has(m));
      pending = pending.filter((m) => laterWithNums.has(m));
      const metrics = [...new Set([...carried, ...local, ...ahead])];
      for (const num of nums) allowNum(num, clause, metrics, blobs, label);
    }
  }
};
