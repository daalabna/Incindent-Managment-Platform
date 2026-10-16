import { GitBranch } from "lucide-react";
import { Card, Empty, text, type Mutate } from "./ui";

export const DependenciesCard = ({
  edges,
  mutate,
}: {
  edges: { service_id: unknown; depends_on: unknown }[];
  mutate: Mutate;
}) => (
  <Card
    icon={<GitBranch size={18} />}
    title="Dependency graph"
    meta={`${edges.length} edges`}
  >
    {edges.length === 0 ? (
      <Empty label="No dependencies yet" />
    ) : (
      <div className="ops-chips">
        {edges.map((edge) => (
          <span
            key={`${text(edge.service_id)}:${text(edge.depends_on)}`}
            className="ops-chip"
          >
            {text(edge.service_id)} <span>→</span> {text(edge.depends_on)}
          </span>
        ))}
      </div>
    )}
    <form
      className="ops-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void mutate("/dependencies", {
          serviceId: f.get("service"),
          dependsOn: f.get("dependency"),
        });
        e.currentTarget.reset();
      }}
    >
      <label>
        Service
        <input name="service" placeholder="search-api" required />
      </label>
      <label>
        Depends on
        <input name="dependency" placeholder="redis" required />
      </label>
      <button className="secondary">Add dependency</button>
    </form>
  </Card>
);
