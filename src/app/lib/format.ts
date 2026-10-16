import type { Health } from "../../../shared/domain";
import { formatErrorRate } from "../../../shared/format";

export const labels = {
  triggered: "Triggered",
  acknowledged: "Acknowledged",
  investigating: "Investigating",
  mitigated: "Mitigated",
  resolved: "Resolved",
} as const;

export const age = (at: string) => {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(at)) / 60000),
  );
  return minutes ? `${minutes}m ago` : "Just now";
};

export const time = (at: string) => {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

export const healthLabel = (health: Health) => {
  if (health === "healthy") return "Healthy";
  if (health === "degraded") return "Degraded";
  if (health === "outage") return "Outage";
  return "Stale";
};

export { formatErrorRate };
