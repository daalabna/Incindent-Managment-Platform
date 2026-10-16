import { expect, it } from "vitest";
import { validateAnalysis } from "../../server/ai/validate";
import { citeLimitations, type AnalysisContext } from "../../server/ai/context";
import { fixtureAnalysis } from "../support/ai-fixture";
import { assertClaimNumbers } from "../../server/ai/claim-numbers";

const ctx = (label: string, text: string): AnalysisContext => ({
  incidentId: "INC-num",
  incidentVersion: 1,
  sources: [{ id: "event:1", kind: "event", label, text }],
  limitations: [],
});

const tryFact = (c: AnalysisContext, claim: string) => {
  const result = fixtureAnalysis(c).result;
  result.facts = [{ text: claim, sources: ["event:1"] }];
  return () => validateAnalysis(result, citeLimitations(c));
};

it("accepts decimal 1.5ms / EU comma / Russian 1,234; rejects fabrications", () => {
  const d15 = ctx("latency ms", '{"value":1.5}');
  expect(tryFact(d15, "latency составляет 1.5ms.")).not.toThrow();
  expect(tryFact(d15, "latency составляет 1.50ms.")).not.toThrow();
  expect(tryFact(d15, "latency составляет 1.5e0ms.")).not.toThrow();
  expect(tryFact(d15, "latency составляет 15e-1ms.")).not.toThrow();
  expect(tryFact(d15, "latency составляет 15ms.")).toThrow(/15|число/i);

  const glued = ctx("sample", "value 1.5ms");
  expect(tryFact(glued, "sample value 1,5ms")).not.toThrow();

  const d1234 = ctx("latency ms", '{"value":1.234}');
  expect(tryFact(d1234, "Задержка составляет 1,234 мс.")).not.toThrow();
});

it("rejects leading-dot .5ms vs 5; accepts .5ms vs 0.5", () => {
  const five = ctx("latency ms", '{"value":5}');
  expect(tryFact(five, "latency ms .5ms")).toThrow(/0\.5|число/i);
  expect(tryFact(five, "latency ms +.5ms")).toThrow(/0\.5|число/i);
  const half = ctx("latency ms", '{"value":0.5}');
  expect(tryFact(half, "latency составляет .5ms.")).not.toThrow();
});

it("rejects version/path/semver/URL number smuggles", () => {
  for (const [corpus, claim] of [
    ["release v1.2", "latency составляет 1.2ms."],
    ["release v1.2", "latency составляет 2ms."],
    ["api-1.2", "latency составляет 1.2ms."],
    ["build/1.2", "latency составляет 1.2ms."],
    ["app 1.2.3", "latency составляет 1.2ms."],
    ["http://h:8080/x", "latency составляет 8080ms."],
    ["date 2024/12/01", "latency составляет 12ms."],
  ] as const) {
    // Exercise numeric provenance directly: unrelated fixture fields must not
    // satisfy this negative test by failing an earlier lexical/unit guard.
    expect(() =>
      assertClaimNumbers(
        claim.replace(/ms/g, ""),
        [`latency ms\n${corpus}`],
        "Факт",
      ),
    ).toThrow(/число/i);
  }
});

it("accepts sci 1e2 and hypothesis verification without token grounding", () => {
  const hundred = ctx("latency ms", '{"value":100}');
  expect(tryFact(hundred, "latency составляет 1e2.")).not.toThrow();

  const d15 = ctx("latency ms", '{"value":1.5}');
  const result = fixtureAnalysis(d15).result;
  result.hypotheses = [
    {
      title: "Причина требует проверки",
      explanation: "latency составляет 1.5.",
      supportingSources: ["event:1"],
      counterEvidence: "Недостаточно данных",
      verification: "Проверить логи сервиса",
    },
  ];
  expect(() => validateAnalysis(result, citeLimitations(d15))).not.toThrow();
});

it("rejects borrowing error_rate value for a latency claim across cites", () => {
  const multi: AnalysisContext = {
    incidentId: "INC-multi",
    incidentVersion: 1,
    sources: [
      {
        id: "event:latency",
        kind: "event",
        label: "latency ms",
        text: '{"type":"latency","value":1}',
      },
      {
        id: "event:errors",
        kind: "event",
        label: "error_rate",
        text: '{"type":"error_rate","value":100}',
      },
    ],
    limitations: [],
  };
  const fact = (text: string) => {
    const result = fixtureAnalysis(multi).result;
    result.facts = [{ text, sources: ["event:latency", "event:errors"] }];
    return () => validateAnalysis(result, citeLimitations(multi));
  };
  expect(fact("Задержка составляет 1 мс.")).not.toThrow();
  expect(fact("Задержка составляет 100 мс.")).toThrow(/число|100/i);
  expect(fact("latency error_rate составляет 100 ms")).toThrow(/число|100/i);
  expect(fact("latency и error_rate составляют 100")).toThrow(/число|100/i);
  expect(fact("latency,, error_rate составляет 100")).toThrow(/число|100/i);
  expect(fact("100 составляет error_rate и latency")).toThrow(/число|100/i);
  expect(fact("Задержка и частота ошибок составляют 100")).toThrow(
    /число|100/i,
  );
  expect(fact("Задержка. Частота ошибок составляет 100.")).not.toThrow();
  expect(fact("latency составляет сто мс")).toThrow(/словесн|число|сто/i);
  expect(fact("оба latency")).toThrow(/словесн|число|оба/i);
  expect(fact("частотою составляет 100")).not.toThrow();
  expect(fact("error rate составляет 100")).not.toThrow();
  expect(fact("error-rate составляет 100")).not.toThrow();
  expect(fact("latency,100")).toThrow(/число|100/i);
  expect(fact("latency/100")).toThrow(/число|100/i);
  expect(
    fact("Задержка составляет 1! Частота ошибок составляет 100."),
  ).not.toThrow();
  expect(
    fact("Задержка составляет 1！ Частота ошибок составляет 100."),
  ).not.toThrow();
  expect(
    fact("latency составляет 1 или error_rate составляет 100"),
  ).not.toThrow();
  expect(
    fact("latency, error_rate составляет 100, latency составляет 1"),
  ).not.toThrow();
  expect(fact("Частота ошибок составляет 1.")).toThrow(/число|1/i);
  expect(fact("Значение составляет 100 мс.")).toThrow(/число|100/i);
  expect(
    fact("Задержка составляет 1 мс, частота ошибок составляет 100."),
  ).not.toThrow();
});

it("allows ms on structured value without unit in corpus", () => {
  const c = ctx("latency", '{"type":"latency","value":1}');
  expect(tryFact(c, "latency составляет 1 ms.")).not.toThrow();
  expect(tryFact(c, "latency составляет 1ms.")).not.toThrow();
});

it("does not infer milliseconds from an arbitrary value or another cited metric", () => {
  for (const type of ["error_rate", "health"]) {
    const c = ctx(type, JSON.stringify({ type, value: 1 }));
    expect(() =>
      validateAnalysis(fixtureAnalysis(c).result, citeLimitations(c)),
    ).not.toThrow();
    for (const unit of ["ms", " ms", " мс"]) {
      expect(tryFact(c, `${type} составляет 1${unit}.`)).toThrow();
    }
  }
  const c = ctx("error_rate", '{"type":"error_rate","value":1}');
  c.sources.push({
    id: "event:latency",
    kind: "event",
    label: "latency ms",
    text: '{"type":"latency","value":1}',
  });
  const result = fixtureAnalysis(c).result;
  result.facts = [
    {
      text: "error_rate составляет 1ms.",
      sources: ["event:1", "event:latency"],
    },
  ];
  expect(() => validateAnalysis(result, citeLimitations(c))).toThrow();
});

it("rejects threshold smuggled as measured value; allows threshold claims", () => {
  const rule = ctx(
    "latency ms",
    '{"metric":"latency","value":1,"threshold":100}',
  );
  expect(tryFact(rule, "Задержка составляет 100 мс.")).toThrow(/число|100/i);
  expect(tryFact(rule, "Задержка составляет 1 мс.")).not.toThrow();
  expect(tryFact(rule, "Порог составляет 100 мс.")).not.toThrow();
  for (const separator of [". ", ", ", "; ", " и "]) {
    expect(
      tryFact(
        rule,
        `Задержка составляет 100 мс${separator}Порог составляет 1 мс.`,
      ),
    ).toThrow();
    expect(
      tryFact(
        rule,
        `Задержка составляет 1 мс${separator}Порог составляет 100 мс.`,
      ),
    ).not.toThrow();
  }
  expect(tryFact(rule, "Порог составляет 1 мс.")).toThrow();
});

it("checks timestamps separately without permitting their numbers as metrics", () => {
  const event = ctx(
    "latency ms",
    '{"value":12,"timestamp":"2026-10-15T12:00:00Z"}',
  );
  expect(() =>
    validateAnalysis(fixtureAnalysis(event).result, citeLimitations(event)),
  ).not.toThrow();
  expect(
    tryFact(event, "2026-10-15T12:00:00Z latency составляет 12 мс."),
  ).not.toThrow();
  expect(
    tryFact(event, "2027-10-15T12:00:00Z latency составляет 12 мс."),
  ).toThrow(/дату/);
  expect(tryFact(event, "latency составляет 2026 мс.")).toThrow(/число/);
});

it("rejects mixed/multi-comma truncation; accepts unicode minus", () => {
  expect(
    tryFact(
      ctx("latency ms", "observed 1,234.5"),
      "Задержка составляет 1.23 мс.",
    ),
  ).toThrow(/число/i);
  expect(
    tryFact(
      ctx("latency ms", '{"value":1.234}'),
      "Задержка составляет 1.234,5 мс.",
    ),
  ).toThrow(/число/i);
  expect(
    tryFact(
      ctx("latency ms", "value 1,234,567"),
      "Задержка составляет 1,234 мс.",
    ),
  ).toThrow(/число/i);
  expect(
    tryFact(
      ctx("latency ms", '{"value":-1.234}'),
      "Задержка составляет −1,234 мс.",
    ),
  ).not.toThrow();
  expect(
    tryFact(ctx("latency ms", "v\u200b1.2"), "latency составляет 1.2ms."),
  ).toThrow(/число/i);
  expect(
    tryFact(ctx("latency ms", "build\\1.2"), "latency составляет 1.2ms."),
  ).toThrow(/число/i);
  expect(
    tryFact(ctx("latency ms", ".5.5"), "latency составляет 0.5ms."),
  ).toThrow(/число/i);
  expect(
    tryFact(ctx("latency ms", "1.2e3.4"), "latency составляет 1200ms."),
  ).toThrow(/число/i);
});
