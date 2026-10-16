import { GitBranch } from "lucide-react";
import type { Rule, Service } from "../../../../shared/domain";
import { RuleToggle } from "./RuleToggle";

export const RuleRow = ({
  rule,
  services,
  onError,
}: {
  rule: Rule;
  services: Service[];
  onError: (message: string) => void;
}) => (
  <div className="rule-row">
    <span className="rule-icon">
      <GitBranch size={22} />
    </span>
    <div>
      <strong>
        {services.find((service) => service.id === rule.serviceId)?.name} ·{" "}
        {rule.metric === "latency" ? "High latency" : "Elevated error rate"}
      </strong>
      <p>
        WHEN{" "}
        <code>
          {rule.metric} &gt; {rule.threshold}
          {rule.metric === "latency" ? "ms" : "%"}
        </code>{" "}
        THEN create{" "}
        <span className={`severity ${rule.severity}`}>{rule.severity}</span>{" "}
        incident
      </p>
    </div>
    <RuleToggle id={rule.id} enabled={rule.enabled} onError={onError} />
  </div>
);
