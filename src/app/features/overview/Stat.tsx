import type { ReactNode } from "react";

export const Stat = ({
  label,
  value,
  foot,
  icon,
  warning,
}: {
  label: string;
  value: string | number;
  foot: string;
  icon: ReactNode;
  warning?: boolean;
}) => (
  <div className="stat">
    <div className="stat-label">
      {label}
      <span>{icon}</span>
    </div>
    <strong className={warning ? "orange" : ""}>{value}</strong>
    <small>{foot}</small>
  </div>
);
