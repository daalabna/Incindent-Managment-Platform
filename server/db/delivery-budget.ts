export const deliveryBudget = {
  /** DB attempt counter (beginDelivery increments before each process). */
  maxAttempts: 4,
  /** Rabbit x-retry-count at which the consumer goes terminal (first try + 3 retries). */
  rabbitTerminalAfter: 3,
  maxAgeMs: 15 * 60_000,
  maxReplays: 5,
} as const;
