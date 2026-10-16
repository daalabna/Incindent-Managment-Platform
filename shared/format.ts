export const formatErrorRate = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—";
