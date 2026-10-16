import { Server } from "lucide-react";
import type { Service } from "../../../../shared/domain";
import { formatErrorRate, healthLabel } from "../../lib/format";
import { Sparkline } from "./Sparkline";

export const ServiceCard = ({ service }: { service: Service }) => (
  <article className="service-card">
    <div className="service-top">
      <span className="service-icon">
        <Server size={17} />
      </span>
      <span className={`service-status ${service.health}`}>
        <span className="dot" />
        {healthLabel(service.health)}
      </span>
    </div>
    <h3>{service.name}</h3>
    <p>{service.description}</p>
    <Sparkline values={service.history} bad={service.health !== "healthy"} />
    <div className="service-metrics">
      <span>
        <strong>
          {Number.isFinite(service.latency) ? service.latency : "—"}
          <small>ms</small>
        </strong>
        Latency
      </span>
      <span>
        <strong>
          {formatErrorRate(service.errorRate)}
          <small>%</small>
        </strong>
        Error rate
      </span>
    </div>
  </article>
);
