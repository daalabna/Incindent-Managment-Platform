import type { Summary } from "../../../shared/domain";
import { RuleRow } from "../features/rules/RuleRow";
import { RulesFooter } from "../features/rules/RulesFooter";

export const RulesPage = ({
  data,
  onError,
}: {
  data: Summary;
  onError: (message: string) => void;
}) => (
  <section className="panel rules-panel">
    {data.rules.map((rule) => (
      <RuleRow
        key={rule.id}
        rule={rule}
        services={data.services}
        onError={onError}
      />
    ))}
    <RulesFooter />
  </section>
);
