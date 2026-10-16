export const cleanupResources = async (
  steps: Array<() => Promise<unknown>>,
) => {
  const results = await Promise.allSettled(steps.map((step) => step()));
  const errors = results.flatMap((result) =>
    result.status === "rejected"
      ? [
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason)),
        ]
      : [],
  );
  if (!errors.length) return;
  return new AggregateError(
    errors,
    errors.map((error) => error.message).join("; "),
  );
};
