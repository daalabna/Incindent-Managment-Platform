/** Allowlist ms-family units after numbers; reject foreign magnitude units. */
export const assertClaimUnits = (
  text: string,
  corpus: string,
  reject: (message: string) => never,
  unitMsg: string,
) => {
  const msUnit = /^(?:ms|mcs|мс|миллисек\w*|millisecond\w*)$/i;
  const notUnit =
    /^(?:e|или|либо|or|and|but|и|а|но|то|же|ли|как|что|для|при|равн\w*|составля\w*|equals?|is|of|to|in|on|at|t|z)$/i;
  const hay = corpus.toLowerCase();
  const scan = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(
      /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?\b/g,
      " ",
    );
  for (const hit of scan.matchAll(
    /\d(?:[.,]\d+)?(?:e[+-]?\d+)?\s*([a-zа-яёµ%]+)|(?<![:\/])\/\s*([a-zа-яё]+)|\bв\s+([a-zа-яё]+)/giu,
  )) {
    const unit = (hit[1] ?? hit[2] ?? hit[3]!).toLowerCase();
    if (msUnit.test(unit) || notUnit.test(unit)) continue;
    if (unit.length >= 3 && hay.includes(unit)) continue;
    reject(unitMsg);
  }
};
