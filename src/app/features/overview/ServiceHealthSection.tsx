import { ArrowRight } from "lucide-react";
import type { Service } from "../../../../shared/domain";
import { ServiceCard } from "../services/ServiceCard";

export const ServiceHealthSection = ({
  services,
  onServices,
}: {
  services: Service[];
  onServices: () => void;
}) => (
  <section className="section">
    <div className="section-heading">
      <h2>
        Service health <span className="count">{services.length}</span>
      </h2>
      <button className="text-button" onClick={onServices}>
        View all services <ArrowRight size={14} />
      </button>
    </div>
    <div className="services-grid">
      {services.map((service) => (
        <ServiceCard key={service.id} service={service} />
      ))}
    </div>
  </section>
);
