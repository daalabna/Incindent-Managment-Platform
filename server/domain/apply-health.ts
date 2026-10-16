import { healthPolicy, type Service } from "../../shared/domain";
import { DomainError } from "./errors";

export const normalizeService = (service: Service): Service => ({
  ...service,
  history: [...(service.history ?? [])],
  observations: { ...(service.observations ?? {}) },
});

const fresh = (at: string | undefined, now: number) =>
  at !== undefined && now - Date.parse(at) <= healthPolicy.freshForMs;

export const aggregateHealth = (service: Service, now = Date.now()) => {
  const observations = service.observations ?? {};
  const health = observations.health;
  const latency = observations.latency;
  const errorRate = observations.error_rate;
  const healthFresh = fresh(health?.at, now);
  const latencyFresh = fresh(latency?.at, now);
  const errorFresh = fresh(errorRate?.at, now);
  if (healthFresh && health !== undefined && health.value !== 0)
    return "outage" as const;
  if (
    (errorFresh &&
      errorRate !== undefined &&
      errorRate.value > healthPolicy.errorRateDegradedAbove) ||
    (latencyFresh &&
      latency !== undefined &&
      latency.value > healthPolicy.latencyDegradedAbove)
  )
    return "degraded" as const;
  if (healthFresh || errorFresh || latencyFresh) return "healthy" as const;
  if (!health && !latency && !errorRate) return "healthy" as const;
  return "unknown" as const;
};

export const refreshServices = <T extends { services: Service[] }>(
  state: T,
  now = Date.now(),
): T => {
  state.services = state.services.map((service) => {
    const normalized = normalizeService(service);
    return { ...normalized, health: aggregateHealth(normalized, now) };
  });
  return state;
};

export const assertFinite = (value: number, label: string) => {
  if (!Number.isFinite(value))
    throw new DomainError(`${label} must be a finite number`);
};
