import type { Service } from "../../../shared/domain";
import { ServiceCard } from "../features/services/ServiceCard";

export const ServicesPage = ({ services }: { services: Service[] }) => (
  <section className="section">
    <div className="section-heading">
      <h2>
        Service health <span className="count">{services.length}</span>
      </h2>
      <span className="muted">
        Live metrics · seeded baseline until events arrive · stale after 5
        minutes
      </span>
    </div>
    <div className="services-grid">
      {services.map((service) => (
        <ServiceCard key={service.id} service={service} />
      ))}
    </div>
  </section>
);
