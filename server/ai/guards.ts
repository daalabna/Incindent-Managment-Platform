import { AiFailure } from "./validate-errors";
import { assertClaimUnits } from "./claim-units";

export { AiFailure } from "./validate-errors";

export const metaOnlyRoot =
  /^(?:(?:причина\s+)?(?:не подтвержден[аоы]?|требует проверк[а-яёa-z]*)(?:\s+из-за\s+(?:нехватки|недостатка)\s+данных(?:\s+о\s+[а-яёa-z0-9_-]+)?)?|недостаточно\s+данных(?:\s+для\s+подтверждения\s+причины)?)\.?$/i;
export const positiveMissing =
  /затронут[аоы](?![а-яё])|нарушен(?:[аоы])?(?![а-яё])|высок(?:ое|ая|ий)(?![а-яё])|ухудш(?!ени)(?!енн)|превыш(?!ени)(?!енн)|пострад(?!авш)|недовольн|жалоб|недоступ(?!ност)|(?<![оo]б?\s)\baffected\b|\bimpacted\b|\bviolat|\bbreach|(?<![оo]б?\s)\bdegrad|\bunhappy\b/i;
export const gapMissing =
  /^(?:нет(?:\s+данных|\s+измерений)|не\s+хватает\s+данных|недостаточно\s+данных|нужны\s+данные|отсутствуют\s+данные)(?:\s|$|[,.:;])/i;
export const gapSmuggle =
  /вырос(?:л[аоы]|[аоы])?(?![а-яё])|возрос(?:л[аоы]|[аоы])?(?![а-яё])|увеличил|увеличен(?:[аоы])?(?![а-яё])|повышен(?:[аоы])?(?![а-яё])|подскоч|(?<!не\s)упал[аоыи]?(?![а-яё])|\bincreas|\bgrew\b|\bgrowing\b|\belevat|\bexceed|\brisen\b|\brose\b|\brising\b|\bspik|\bsurge(?:d|s)?\b|\bsurging\b|\bclimb|\bsoar|\bjump|\bdoubl|\btripl|\bquadrupl|\bskyrocket|\bworsen|\bplung|\bcrash|\bcollaps|\boffline\b|\boutage\b|high\s+latency|выше\s+(?:обычн|норм|типичн|порог)|относительно\s+(?:обычн|нормальн|типичн)|(?:versus|vs\.?)\s+(?:baseline|normal|typical)|compared\s+to\s+(?:baseline|normal)|up\s+from\s+baseline|higher\s+than|above\s+(?:the\s+)?(?:threshold|baseline|normal)|over\s+(?:the\s+)?(?:threshold|baseline)|beyond\s+(?:the\s+)?threshold|worse\s+than|(?:превыш\w*|exceed\w*)\s+(?:порог|threshold)|service\s+(?:is\s+)?down\b|\bis\s+down\b|существенно\s+выше|значительно\s+выше/i;

const highValue =
  /высокое\s+значение|высокая\s+(?:задерж|latency)|высокий\s+(?:latency|уровень)|ухудшен|\bhigh\s+latency\b|\bdegrad|\bspik/i;

const reject = (message: string): never => {
  throw new AiFailure(message);
};
const unsupported = (
  text: string,
  corpus: string,
  claim: RegExp,
  evidence: RegExp,
) => claim.test(text) && !evidence.test(corpus);

export const hasMilliseconds = (text: string) =>
  /\dms\b|\bms\b|мс|миллисек|\bmilliseconds?\b/i.test(text);
/** ms allowed for latency sources (label/type) or explicit ms — not bare `"value"`. */
export const supportsMilliseconds = (corpus: string) =>
  hasMilliseconds(corpus) ||
  /"(?:type|metric)"\s*:\s*"latency"/i.test(corpus) ||
  /\blatency\b|задержк/i.test(corpus);

export const guardText = (text: string, corpus: string) => {
  if (
    unsupported(
      text,
      corpus,
      /обычн|нормальн|типичн|\bbaseline\b|\btypical\b|\bnormal\b/i,
      /обычн|нормальн|типичн|baseline|typical|normal/i,
    )
  )
    reject(
      "Ответ сравнивает значение с обычным уровнем, которого нет в измеренном источнике. Анализ отклонён.",
    );
  if (
    unsupported(
      text,
      corpus,
      /пользовател|клиентск|\busers?\b|\bcustomers?\b/i,
      /пользовател|клиентск|\busers?\b|\bcustomers?\b/i,
    )
  )
    reject(
      "Ответ упоминает пользователей, хотя измеренный источник этого не содержит. Анализ отклонён.",
    );
  if (unsupported(text, corpus, /\bsla\b/i, /\bsla\b/i))
    reject(
      "Ответ упоминает SLA, хотя измеренный источник этого не содержит. Анализ отклонён.",
    );
  if (
    unsupported(
      text,
      corpus,
      /возрос|вырос|увеличил|увеличен|повышен|превыш|подскоч|(?<!не\s)упал|недоступ(?!ност)|\bincreas|\bgrew\b|\bgrowing\b|\brising\b|\bsurge(?:d|s)?\b|\bsurging\b|\bspik|\bexceed|\bdoubl|\btripl|\bquadrupl|\bskyrocket|\bworsen|\bplung|\bcrash|\bcollaps|\boffline\b|\boutage\b/i,
      /возрос|вырос|увеличил|увеличен|повышен|превыш|подскоч|упал|недоступ|increas|grew|growing|rising|surge|spik|exceed|doubl|tripl|quadrupl|skyrocket|worsen|plung|crash|collaps|offline|outage/i,
    )
  )
    reject(
      "Ответ описывает рост значения без такого изменения в измеренном источнике. Анализ отклонён.",
    );
  if (unsupported(text, corpus, highValue, highValue))
    reject(
      "Ответ оценивает величину или ухудшение, хотя измеренный источник этого не говорит. Анализ отклонён.",
    );
  if (
    /порог|threshold|over\s+(?:the\s+)?threshold/i.test(text) &&
    !/порог|threshold/i.test(corpus)
  )
    reject(
      "Ответ ссылается на порог, которого нет в измеренном источнике. Анализ отклонён.",
    );
  const unitMsg =
    "Ответ добавляет единицу измерения, которой нет в измеренном источнике. Анализ отклонён.";
  if (hasMilliseconds(text) && !supportsMilliseconds(corpus)) reject(unitMsg);
  assertClaimUnits(text, corpus, reject, unitMsg);
};

const metaRoots = [
  "неподтвержд",
  "зафиксир",
  "подтвержд",
  "недостат",
  "отсутств",
  "наблюден",
  "инцидент",
  "контекст",
  "источник",
  "измерен",
  "утвержд",
  "нехватк",
  "составля",
  "событ",
  "значен",
  "связан",
  "причин",
  "провер",
  "фиксир",
  "содерж",
  "образц",
  "данн",
  "требу",
  "нужн",
  "равн",
  "явля",
].sort((a, b) => b.length - a.length);
const metaSuffix =
  /^(?:|а|у|е|ы|и|о|я|ю|ом|ец|ам|ами|ах|ов|ев|ём|ем|ит|ют|ые|ых|ым|ыми|ой|ая|ое|ый|ого|ому|ить|ять|ка|ки|ке|ку|кой|ками|ет|ется|яется|ается|ена|ено|ены|ение|ения|ением|ению|ении|ениями|ие|ия|ий|ию|ии|иям|иями|ием|ью|ими|анием|овно|ована|овано|ованы|ованный|ованная|ованное|ованные|ованных|ованным|ованными|енная|енное|енные|енных|енным|енными|енной|очно|очна|очны|очный|очная|очное|очные|ный|ная|ное|ные|ных|ным|ными|ного|ному|ной|ует|уют|ующими)$/u;
const isMetaLexeme = (token: string) => {
  const lower = token.toLowerCase();
  for (const root of metaRoots) {
    if (lower.startsWith(root) && metaSuffix.test(lower.slice(root.length)))
      return true;
  }
  return false;
};
const groundedHaystack = (corpus: string) => {
  const hay = corpus.toLowerCase();
  const extras: string[] = [];
  if (/\blatency\b/.test(hay))
    extras.push("задержка", "задержки", "задержку", "задержкой", "задержке");
  if (/задержк/.test(hay)) extras.push("latency");
  if (/\berror_rate\b|error\s+rate/.test(hay))
    extras.push(
      "частота",
      "частоты",
      "частоте",
      "частотой",
      "частотою",
      "ошибок",
      "ошибки",
      "ошибка",
      "ошибками",
      "error",
      "rate",
    );
  if (/частот[а-яё]*\s+ошиб|ошиб[а-яё]*\s+частот/.test(hay))
    extras.push("error_rate");
  if (/\bthreshold\b/.test(hay))
    extras.push("порог", "порога", "порогу", "порогом");
  if (/порог/.test(hay)) extras.push("threshold");
  return extras.length ? `${hay}\n${extras.join(" ")}` : hay;
};

const foldLatin = (value: string) => {
  let text = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "");
  for (let i = 0; i < 8; i++) {
    const next = text
      .replace(/([a-z0-9])_+(?=[a-z0-9])/g, "$1")
      .replace(/([a-z0-9])-+(?=[a-z0-9])/g, (all, left: string) =>
        /e/i.test(left) ? all : left,
      )
      .replace(/([a-z])\.+(?=[a-z0-9])/g, "$1")
      .replace(/([a-z0-9])\.+(?=[a-z])/g, "$1");
    if (next === text) break;
    text = next;
  }
  return text.replace(
    /(?<![a-z0-9])(?:[a-z][^a-z0-9а-яё]+){1,}[a-z](?![a-z0-9])/g,
    (chunk) => chunk.replace(/[^a-z]+/g, ""),
  );
};

const latinSkip = new Set([
  "is",
  "of",
  "to",
  "in",
  "on",
  "at",
  "or",
  "an",
  "as",
  "by",
  "be",
  "we",
  "it",
  "if",
  "do",
  "so",
  "no",
  "up",
  "the",
  "and",
  "for",
  "are",
]);
const numToken =
  /(?<![\p{L}\p{N}])[+-]?(?:\d+(?:[.,]\d+)+|\.\d+(?:[.,]\d+)+|\d+|\.\d+)(?:e[+-]?\d+)?/giu;
const saneNum = (raw: string) =>
  (
    raw
      .replace(/^[+-]/, "")
      .replace(/e[+-]?\d+$/i, "")
      .match(/[.,]/g) ?? []
  ).length <= 1;
export const canonNum = (raw: string) => {
  let s = raw
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/,/g, ".")
    .toLowerCase();
  if (/^[+-]?\./.test(s)) s = s.replace(/^([+-]?)\./, "$10.");
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
};
export const numsOf = (value: string) => {
  const scrubbed = value
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/\p{M}/gu, "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bv\d+(?:\.\d+)+\b/gi, " ")
    .replace(/[_\\]+/g, " ")
    .replace(/(?<=(?:ms|мс|%))(?=\d)/gi, " ")
    .replace(/(?<=[а-яё])(?=\d)/giu, " ");
  return [...scrubbed.matchAll(numToken)].map((hit) => {
    const raw = hit[0]!;
    const end = (hit.index ?? 0) + raw.length;
    if (/e[+-]?\d+$/i.test(raw) && /^\.\d/.test(scrubbed.slice(end)))
      return `${raw.toLowerCase()}.`;
    return saneNum(raw) ? canonNum(raw) : raw.toLowerCase();
  });
};

const nonMeasureJson =
  /"(threshold|limit|budget|baseline|max|min|window[_-]?\w*|samples|id|rule[_-]?id|event[_-]?ids?|sequence)"\s*:\s*[+-]?\d+(?:[.,]\d+)?(?:e[+-]?\d+)?/gi;
const fieldNums = (key: string, corpus: string) =>
  [
    ...corpus.matchAll(
      new RegExp(
        `"${key}"\\s*:\\s*([+-]?\\d+(?:[.,]\\d+)?(?:e[+-]?\\d+)?)`,
        "gi",
      ),
    ),
  ].map((h) => canonNum(h[1]!));
export const measuredNumsOf = (corpus: string) => {
  const values = fieldNums("value", corpus);
  if (values.length) return values;
  const scrub = corpus
    .replace(nonMeasureJson, " ")
    .replace(/\b\d{4}\/\d{1,2}\/\d{1,2}\b/g, " ")
    .replace(/\b[a-z][a-z0-9_-]*[\\/_-]\d+(?:\.\d+)*/gi, " ");
  return numsOf(scrub);
};
export const numsForClaim = (corpus: string, claim: string) => {
  const roles = [
    ["threshold", /порог|\bthreshold\b/i],
    ["limit", /лимит|\blimit\b/i],
    ["budget", /бюджет|\bbudget\b/i],
    ["baseline", /\bbaseline\b/i],
  ] as const;
  const role = roles.find(([, pattern]) => pattern.test(claim));
  return new Set(role ? fieldNums(role[0], corpus) : measuredNumsOf(corpus));
};

const tokensOf = (value: string) => {
  const found: string[] = [];
  for (const match of foldLatin(
    value.replace(/[\u2212\u2013\u2014]/g, "-"),
  ).matchAll(
    /[+-]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:e[+-]?\d+)?[a-zа-яё]*|[a-zа-яё0-9]+/gu,
  )) {
    const token = match[0]!;
    if (token.length >= 4 || /[.,e]/i.test(token)) found.push(token);
    else if (
      token.length >= 2 &&
      /^[a-z0-9]+$/i.test(token) &&
      !latinSkip.has(token)
    )
      found.push(token);
  }
  return found;
};

const numShape = /^[+-]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;
const measureCompound =
  /^([+-]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:e[+-]?\d+)?)(ms|мс)$/i;
const measureGrounded = (token: string, corpus: string) => {
  const nums = new Set(numsOf(corpus));
  const measured = measureCompound.exec(token);
  if (measured)
    return (
      nums.has(canonNum(measured[1]!)) &&
      (hasMilliseconds(corpus) || /"value"\s*:\s*[+-]?\d/i.test(corpus))
    );
  return numShape.test(token) && nums.has(canonNum(token));
};
export const assertGroundedTokens = (text: string, corpus: string) => {
  const haystack = groundedHaystack(corpus);
  const corpusTokens = new Set(tokensOf(haystack));
  const tokens = tokensOf(text.toLowerCase());
  const structured = /"value"\s*:\s*[+-]?\d/i.test(haystack);
  let grounded = 0;
  for (const token of tokens) {
    if (isMetaLexeme(token)) continue;
    if (
      !corpusTokens.has(token) &&
      !measureGrounded(token, haystack) &&
      !(structured && /^(ms|мс|миллисек)$/i.test(token))
    )
      reject(
        `Утверждение добавляет «${token}», которого нет в измеренном источнике. Анализ отклонён.`,
      );
    grounded++;
  }
  if (tokens.length > 0 && grounded === 0 && !metaOnlyRoot.test(text.trim()))
    reject(
      "Утверждение не содержит измеренного содержания, только общие слова. Анализ отклонён.",
    );
};
export const rejectGuard = reject;
