import { expect, it, vi } from "vitest";
import { AiQueue } from "../../server/ai/queue";
import { validateAnalysis } from "../../server/ai/validate";
import {
  citeLimitations,
  contextHash,
  redactEvidence,
  takeSources,
  type AnalysisContext,
} from "../../server/ai/context";
import { fixtureAnalysis } from "../support/ai-fixture";
import { analysisSchema } from "../../shared/ai";

const context: AnalysisContext = {
  incidentId: "INC-1001",
  incidentVersion: 1,
  sources: [
    {
      id: "incident:INC-1001",
      kind: "incident",
      label: "Incident",
      text: "One alert",
    },
    { id: "event:1", kind: "event", label: "sample", text: '{"value":1}' },
  ],
  limitations: [],
};
it("rejects invented source references and malformed model output", () => {
  const cited = citeLimitations(context);
  const result = fixtureAnalysis(context).result;
  expect(validateAnalysis(result, cited)).toMatchObject({
    ...result,
    statuses: {
      rootCause: "unconfirmed",
      missingData: ["limitation_ref"],
    },
  });
  // Re-entry after provider enrichment must not reject statuses.
  expect(
    validateAnalysis(
      {
        ...result,
        statuses: { rootCause: "observed", missingData: ["gap"] },
      },
      cited,
    ).statuses,
  ).toEqual({ rootCause: "unconfirmed", missingData: ["limitation_ref"] });
  expect(() =>
    validateAnalysis(
      {
        ...result,
        summary: { ...result.summary, sources: ["event:invented"] },
      },
      cited,
    ),
  ).toThrow(/источник/);
  expect(() =>
    validateAnalysis(
      { ...result, nextChecks: [{ action: "Do something" }] },
      cited,
    ),
  ).toThrow();
  expect(
    analysisSchema.safeParse({ ...result, execute: "shell command" }).success,
  ).toBe(false);
  expect(() =>
    validateAnalysis(
      {
        ...result,
        summary: {
          text: "Подтверждённый root cause: оператор выполнил недокументированную команду.",
          sources: [context.sources[0]!.id],
        },
      },
      cited,
    ),
  ).toThrow(/измерен/);
  expect(
    analysisSchema.safeParse({
      ...result,
      postmortem: { ...result.postmortem, rootCause: "свободно" },
    }).success,
  ).toBe(false);
  expect(() =>
    validateAnalysis(
      {
        ...result,
        postmortem: {
          ...result.postmortem,
          rootCause: {
            text: "Подтверждённый root cause: оператор выполнил недокументированную команду.",
            sources: [context.sources[0]!.id],
          },
        },
      },
      cited,
    ),
  ).toThrow(/измерен/);
  const bare = citeLimitations({
    ...context,
    sources: [
      context.sources[0]!,
      {
        id: "event:1",
        kind: "event" as const,
        label: "latency",
        text: '{"value":1800}',
      },
    ],
  });
  const rich = citeLimitations({
    ...context,
    sources: [
      context.sources[0]!,
      {
        id: "event:1",
        kind: "event" as const,
        label: "latency",
        text: "Latency выросла относительно обычного уровня, пользователи затронуты",
      },
    ],
  });
  const base = fixtureAnalysis(bare).result;
  const cite = (text: string) => ({ text, sources: ["event:1"] });
  expect(() =>
    validateAnalysis(
      { ...base, summary: cite("1800 значительно превышает обычные значения") },
      bare,
    ),
  ).toThrow(/обычным уровнем/);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        postmortem: {
          ...base.postmortem,
          impact: cite("значение выше порога"),
        },
      },
      bare,
    ),
  ).toThrow(/порог/);
  expect(() =>
    validateAnalysis({ ...base, facts: [cite("latency равна 999 мс")] }, bare),
  ).toThrow(/число|999/);
  expect(() =>
    validateAnalysis({ ...base, facts: [cite("latency равна 1800 мс")] }, bare),
  ).not.toThrow();
  expect(() =>
    validateAnalysis(
      {
        ...base,
        postmortem: {
          ...base.postmortem,
          impact: cite("могло сказаться на пользовательском опыте"),
        },
      },
      bare,
    ),
  ).toThrow(/пользователей/);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        postmortem: {
          ...base.postmortem,
          rootCause: cite(
            "Причина не подтверждена, однако выявлено, что задержка могла повлиять",
          ),
        },
      },
      bare,
    ),
  ).toThrow(/Неподтверждённая причина|Причинный вывод/);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        summary: cite(
          "Зафиксировано высокое значение задержки и ухудшение производительности",
        ),
      },
      bare,
    ),
  ).toThrow(/ухудшение/);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        hypotheses: [
          {
            title: "Деплой",
            explanation: "Пользователи затронуты и SLA нарушен",
            supportingSources: [context.sources[0]!.id],
            counterEvidence: "нет данных",
            verification: "логи",
          },
        ],
      },
      bare,
    ),
  ).toThrow(/измерен/);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нужны данные о нарушении SLA"] },
      bare,
    ).missingData[0],
  ).toMatch(/Нужны данные/);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных о числе затронутых пользователей"] },
      bare,
    ).missingData[0],
  ).toMatch(/затронутых/);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных о высоком значении latency"] },
      bare,
    ).missingData[0],
  ).toMatch(/высоком/);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; пользователи затронуты"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: [
          "Нет данных о логах; latency выросла относительно обычного уровня",
        ],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: [
          "Нет данных о логах, latency выросла относительно обычного уровня",
        ],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: [
          "Нет данных о логах: latency выросла относительно обычного уровня",
        ],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: [
          "Нет данных о логах и latency выросла относительно обычного уровня",
        ],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных о пороге срабатывания алерта"] },
      bare,
    ).missingData[0],
  ).toMatch(/пороге/);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных о обычном уровне latency"] },
      bare,
    ).missingData[0],
  ).toMatch(/обычном/);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: [
          "Нет данных о логах and latency increased versus baseline",
        ],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: ["Нет данных о логах; latency grew vs baseline"],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных об увеличенной нагрузке"] },
      bare,
    ).missingData[0],
  ).toMatch(/увеличенной/);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных о повышенной задержке"] },
      bare,
    ).missingData[0],
  ).toMatch(/повышенной/);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; latency risen vs normal"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: ["Нет данных о логах и пользователи пострадали"],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; users are impacted"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных о выросшей задержке"] },
      bare,
    ).missingData[0],
  ).toMatch(/выросшей/);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных об ухудшении latency"] },
      bare,
    ).missingData[0],
  ).toMatch(/ухудшении/);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных об ухудшенной доступности"] },
      bare,
    ).missingData[0],
  ).toMatch(/ухудшенной/);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных о превышенном пороге"] },
      bare,
    ).missingData[0],
  ).toMatch(/превышенном/);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных о пострадавших пользователях"] },
      bare,
    ).missingData[0],
  ).toMatch(/пострадавших/);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; latency climbing"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; latency surging"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; latency skyrocketed"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; доступность упала"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; latency подскочила"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; latency vs typical"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: ["Нет данных о логах; beyond the threshold"],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: ["Нет данных о логах и жалобы пользователей"],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о жалобах пользователей"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; surgery runbook"] },
      bare,
    ).missingData[0],
  ).toMatch(/surgery/);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; latency quadrupled"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; сервис недоступен"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных о недоступности региона"] },
      bare,
    ).missingData[0],
  ).toMatch(/недоступности/);
  expect(
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; значение не упало"] },
      bare,
    ).missingData[0],
  ).toMatch(/не упало/);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах; host offline"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        postmortem: {
          ...base.postmortem,
          rootCause: {
            text: "Причина не подтверждена из-за недостатка данных о latency spike",
            sources: ["limitations"],
          },
        },
      },
      bare,
    ),
  ).toThrow(/ухудшение|величин|рост|нехватке данных|неподтвержд/i);
  expect(() =>
    validateAnalysis(
      { ...base, facts: [cite("latency увеличил нагрузку")] },
      bare,
    ),
  ).toThrow(/рост/);
  expect(() =>
    validateAnalysis({ ...base, facts: [cite("latency is rising")] }, bare),
  ).toThrow(/рост/);
  expect(() =>
    validateAnalysis(
      { ...base, facts: [cite("значение over the threshold")] },
      bare,
    ),
  ).toThrow(/порог/);
  expect(() =>
    validateAnalysis(
      { ...base, missingData: ["Нет данных о логах и latency выше типичного"] },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: ["Нет данных о логах; latency up from baseline"],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: ["Нет данных о логах; latency higher than baseline"],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: ["Нет данных о логах; latency above the threshold"],
      },
      bare,
    ),
  ).toThrow(/воздействие|ущерб|missingData/i);
  expect(
    validateAnalysis(
      {
        ...base,
        postmortem: {
          ...base.postmortem,
          rootCause: {
            text: "Недостаточно данных для подтверждения причины.",
            sources: ["limitations"],
          },
        },
      },
      bare,
    ).postmortem.rootCause.text,
  ).toMatch(/Недостаточно данных/);
  expect(
    validateAnalysis(
      {
        ...base,
        postmortem: {
          ...base.postmortem,
          rootCause: {
            text: "Причина требует проверки.",
            sources: ["limitations"],
          },
        },
      },
      bare,
    ).postmortem.rootCause.text,
  ).toMatch(/проверки/);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        postmortem: {
          ...base.postmortem,
          rootCause: {
            text: "Причина не подтверждена из-за недостатка данных о деплое который сломал кэш.",
            sources: ["limitations"],
          },
        },
      },
      bare,
    ),
  ).toThrow(/неподтвержд|нехватк|измерени/i);

  expect(() =>
    validateAnalysis(
      {
        ...base,
        summary: {
          text: "Сервис обеспечивает высокую доступность",
          sources: [context.sources[0]!.id],
        },
      },
      bare,
    ),
  ).toThrow(/измерен/);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        summary: { text: "Users are affected", sources: ["event:1"] },
      },
      bare,
    ),
  ).toThrow(/пользователей/);
  expect(() =>
    validateAnalysis({ ...base, facts: [cite("high latency")] }, bare),
  ).toThrow(/ухудшение|величин/);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        postmortem: { ...base.postmortem, impact: cite("exceeds threshold") },
      },
      bare,
    ),
  ).toThrow(/порог|рост/);
  const metaOnly = {
    ...base,
    facts: [
      { text: "latency равна 1800", sources: ["limitations"] as string[] },
    ],
    nextChecks: [] as typeof base.nextChecks,
    hypotheses: [] as typeof base.hypotheses,
    postmortem: {
      ...base.postmortem,
      impact: { text: "недостаточно данных", sources: ["limitations"] },
      timeline: [] as typeof base.postmortem.timeline,
      actionsTaken: [] as typeof base.postmortem.actionsTaken,
      prevention: [] as typeof base.postmortem.prevention,
    },
  };
  expect(() =>
    validateAnalysis(
      {
        ...metaOnly,
        summary: { text: "latency равна 1800", sources: ["service:1"] },
      },
      citeLimitations({
        ...context,
        sources: [
          context.sources[0]!,
          {
            id: "service:1",
            kind: "service" as const,
            label: "svc",
            text: '{"observations":{"latency":{"value":1800}}}',
          },
        ],
      }),
    ),
  ).toThrow(/измерен|измерени/);
  expect(() =>
    validateAnalysis(
      {
        ...metaOnly,
        summary: { text: "latency равна 1800", sources: ["limitations"] },
      },
      bare,
    ),
  ).toThrow(/limitations|измерени/);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        hypotheses: [
          {
            title: "Spike",
            explanation: "latency равна 9999",
            supportingSources: ["limitations"],
            counterEvidence: "нет",
            verification: "логи",
          },
        ],
        postmortem: {
          ...base.postmortem,
          prevention: [
            { text: "latency равна 9999", sources: ["limitations"] },
          ],
        },
      },
      bare,
    ),
  ).toThrow(/измерени|limitations/);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        postmortem: {
          ...base.postmortem,
          rootCause: { text: "latency равна 9999", sources: ["limitations"] },
        },
      },
      bare,
    ),
  ).toThrow(/числ|измерени|limitations/);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        postmortem: {
          ...base.postmortem,
          rootCause: {
            text: "Корневая причина: неудачный деплой сломал кэш.",
            sources: ["limitations"],
          },
        },
      },
      bare,
    ),
  ).toThrow(/неподтвержд|нехватк|измерени/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        postmortem: {
          ...base.postmortem,
          rootCause: {
            text: "Причина не подтверждена: неудачный деплой сломал кэш.",
            sources: ["limitations"],
          },
        },
      },
      bare,
    ),
  ).toThrow(/неподтвержд|нехватк|измерени/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: ["latency равна 9999"],
      },
      bare,
    ),
  ).toThrow(/число|missingData|limitations/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: ["пользователи затронуты, SLA нарушен"],
      },
      citeLimitations({
        ...context,
        sources: [
          context.sources[0]!,
          {
            id: "event:1",
            kind: "event" as const,
            label: "latency",
            text: '{"value":1800}',
          },
        ],
        limitations: ["Нет данных о пользователях и SLA."],
      }),
    ),
  ).toThrow(/воздействие|ущерб|пользовател|SLA/i);
  const withUsersLimit = citeLimitations({
    ...context,
    sources: [
      context.sources[0]!,
      {
        id: "event:1",
        kind: "event" as const,
        label: "latency",
        text: '{"value":1800}',
      },
    ],
    limitations: ["Нет данных о пользователях и SLA."],
  });
  expect(() =>
    validateAnalysis(
      {
        ...base,
        summary: {
          text: "пользователи затронуты, SLA нарушен",
          sources: ["event:1", "limitations"],
        },
      },
      withUsersLimit,
    ),
  ).toThrow(/пользовател|SLA/i);
  expect(() =>
    validateAnalysis(
      {
        ...base,
        missingData: ["Нет данных о пользователях и SLA"],
        postmortem: {
          ...base.postmortem,
          rootCause: {
            text: "пользователи затронуты, SLA нарушен",
            sources: ["event:1", "limitations"],
          },
        },
      },
      withUsersLimit,
    ),
  ).toThrow(/пользовател|SLA|Причинный вывод/i);
  const fromEvent = (text: string) => ({ text, sources: ["event:1"] });
  const richBase = fixtureAnalysis(rich).result;
  expect(
    validateAnalysis(
      {
        ...richBase,
        summary: fromEvent(
          "Latency выросла относительно обычного уровня, пользователи затронуты",
        ),
        facts: [
          fromEvent(
            "Latency выросла относительно обычного уровня, пользователи затронуты",
          ),
        ],
        postmortem: {
          ...richBase.postmortem,
          impact: fromEvent("пользователи затронуты"),
          timeline: [fromEvent("Latency выросла")],
          rootCause: {
            text: "Причина не подтверждена.",
            sources: ["limitations"],
          },
        },
      },
      rich,
    ).summary.text,
  ).toContain("обычного");
});

it("redacts known credential forms and hashes evidence changes, not only the incident version", () => {
  expect(
    redactEvidence(
      "sk-1234567890123456 token=abcdef Bearer abc.def https://alice:password@example.test",
    ),
  ).toBe(
    "[REDACTED] token=[REDACTED] Bearer [REDACTED] https://[REDACTED]@example.test",
  );
  expect(redactEvidence('{"password":"FAKE_REVIEW_PASSWORD"}')).toBe(
    '{"password":"[REDACTED]"}',
  );
  expect(redactEvidence('{"password":"FAKE_REVIEW_PASSWORD"}')).not.toContain(
    "FAKE_REVIEW_PASSWORD",
  );
  expect(contextHash(context)).toBe(contextHash(structuredClone(context)));
  expect(
    contextHash({
      ...context,
      sources: [{ ...context.sources[0]!, text: "Changed" }],
    }),
  ).not.toBe(contextHash(context));
});
it("closes only the AI channel when that channel stops", async () => {
  let connectionClosed = false;
  const handlers = new Map<string, () => void>();
  const channel = {
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return channel;
    },
    assertQueue: async () => undefined,
    prefetch: async () => undefined,
    close: async () => {
      handlers.get("close")?.();
    },
    cancel: async () => undefined,
  };
  const queue = new AiQueue(
    "ns",
    async () => undefined,
    () => undefined,
  );
  await queue.attach(
    {
      createConfirmChannel: async () => channel,
      close: async () => {
        connectionClosed = true;
      },
    } as never,
    false,
  );
  await queue.close();
  expect(connectionClosed).toBe(false);
});
it("stops reopening the AI channel after repeated broker cancels", async () => {
  vi.useFakeTimers();
  try {
    let opens = 0;
    const queue = new AiQueue(
      "ns",
      async () => undefined,
      () => undefined,
    );
    const connection = {
      createConfirmChannel: async () => {
        opens += 1;
        const handlers = new Map<string, () => void>();
        return {
          on: (event: string, handler: () => void) => {
            handlers.set(event, handler);
          },
          assertQueue: async () => undefined,
          prefetch: async () => undefined,
          consume: async (
            _name: string,
            onMessage: (message: null) => void,
          ) => {
            onMessage(null);
            return { consumerTag: `c${opens}` };
          },
          close: async () => {
            handlers.get("close")?.();
          },
          cancel: async () => undefined,
          checkQueue: async () => ({ messageCount: 0 }),
          ack: () => undefined,
          nack: () => undefined,
        };
      },
      close: async () => undefined,
    };
    await queue.attach(connection as never, true);
    for (let step = 0; step < 8; step++)
      await vi.advanceTimersByTimeAsync(1000);
    expect(opens).toBe(6);
    expect(await queue.health()).toMatchObject({ ready: false, queued: null });
    await queue.close();
  } finally {
    vi.useRealTimers();
  }
});
it("reconnects again after the channel has already run stably", async () => {
  vi.useFakeTimers();
  let last: { close: () => Promise<void> } | undefined;
  let opens = 0;
  const queue = new AiQueue(
    "review",
    async () => undefined,
    () => undefined,
  );
  try {
    const connection = {
      createConfirmChannel: async () => {
        opens += 1;
        const handlers = new Map<string, () => void>();
        const channel = {
          on: (event: string, handler: () => void) => {
            handlers.set(event, handler);
            return channel;
          },
          assertQueue: async () => undefined,
          prefetch: async () => undefined,
          consume: async () => ({ consumerTag: "valid" }),
          checkQueue: async () => ({ messageCount: 0, consumerCount: 1 }),
          cancel: async () => undefined,
          close: async () => {
            handlers.get("close")?.();
          },
        };
        last = channel;
        return channel;
      },
      close: async () => undefined,
    };
    await queue.attach(connection as never, true);
    for (let step = 0; step < 5; step++) {
      await last?.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await queue.health()).ready).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await last?.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(opens).toBe(7);
    expect((await queue.health()).ready).toBe(true);
  } finally {
    await queue.close();
    vi.useRealTimers();
  }
});
it("does not reopen an AI channel when shutdown starts while it is opening", async () => {
  let release: () => void = () => undefined;
  let opened: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const queue = new AiQueue(
    "ns",
    async () => undefined,
    () => undefined,
  );
  const connection = {
    createConfirmChannel: async () => ({
      on: () => undefined,
      assertQueue: () => {
        opened();
        return gate;
      },
      prefetch: async () => undefined,
      consume: async () => ({ consumerTag: "c" }),
      close: async () => undefined,
      cancel: async () => undefined,
      checkQueue: async () => ({ messageCount: 0, consumerCount: 0 }),
    }),
    close: async () => undefined,
  };
  const opening = queue.attach(connection as never, true);
  await waiting;
  await queue.close();
  release();
  await opening;
  expect(await queue.health()).toMatchObject({
    ready: false,
    connected: false,
  });
});
it("keeps measured events when timeline comments fill their own quota", () => {
  const fitted = takeSources([
    { kind: "incident", label: "INC", text: "alert" },
    { kind: "event", label: "latency", text: JSON.stringify({ value: 2000 }) },
    ...Array.from({ length: 25 }, (_, index) => ({
      kind: "timeline" as const,
      label: String(index),
      text: "x".repeat(1200),
    })),
  ]);
  expect(fitted.sources.some((source) => source.kind === "event")).toBe(true);
  expect(
    fitted.sources.filter((source) => source.kind === "timeline").length,
  ).toBeLessThan(25);
  expect(fitted.omitted.timeline).toBeGreaterThan(0);
  expect(fitted.sources.every((source) => !source.id.includes("FAKE"))).toBe(
    true,
  );
  const overflowing = takeSources([
    { kind: "incident", label: "I", text: "x".repeat(1200) },
    ...Array.from({ length: 7 }, () => ({
      kind: "event" as const,
      label: "e",
      text: "x".repeat(1100),
    })),
    ...Array.from({ length: 6 }, () => ({
      kind: "timeline" as const,
      label: "t",
      text: "x".repeat(1200),
    })),
    ...Array.from({ length: 8 }, () => ({
      kind: "rule" as const,
      label: "r",
      text: "x".repeat(1200),
    })),
  ]);
  const cost = overflowing.sources.reduce(
    (sum, source) => sum + source.label.length + source.text.length,
    0,
  );
  const ruleCost = overflowing.sources
    .filter((source) => source.kind === "rule")
    .reduce((sum, source) => sum + source.label.length + source.text.length, 0);
  expect(cost).toBeLessThanOrEqual(24000);
  expect(ruleCost).toBeLessThanOrEqual(4000);
  expect(overflowing.omitted.rule).toBeGreaterThan(0);
});
