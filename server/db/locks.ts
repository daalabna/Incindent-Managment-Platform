const lockName = ["events", "dependencies", "retention", "migrate"] as const;
export type AdvisoryLock = (typeof lockName)[number];

export const advisoryLockSql = (name: AdvisoryLock) =>
  `SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':${name}', 0))`;
