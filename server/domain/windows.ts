import type { Rule } from "../../shared/domain";

export const windowStart = (time: number, seconds: number) =>
  Math.floor(time / (seconds * 1000)) * seconds * 1000;
export type WindowAggregate = {
  samples: number;
  maximum: number;
  average: number;
  sustained: boolean;
};

export const matchesAggregate = (sample: WindowAggregate, rule: Rule) => {
  if (sample.samples < (rule.minSamples ?? 2)) return false;
  if (rule.aggregation === "all") return sample.sustained;
  return (
    (rule.aggregation === "max" ? sample.maximum : sample.average) >
    rule.threshold
  );
};

export type RuleEvidence = {
  ruleId: string;
  serviceId: string;
  metric: Rule["metric"];
  aggregation: "point" | "avg" | "max" | "all";
  threshold: number;
  value: number;
  samples: number;
  windowStart: string | null;
  windowEnd: string | null;
  eventIds: string[];
};

const rounded = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

export const evidenceBasis = (items: RuleEvidence[]) =>
  items
    .map((item) =>
      item.windowStart
        ? `${item.serviceId} ${item.ruleId}: ${item.metric} ${item.aggregation}=${rounded(item.value)} за окно ${item.windowStart}–${item.windowEnd}, samples=${item.samples}`
        : `${item.metric} = ${rounded(item.value)}`,
    )
    .join("; ");
