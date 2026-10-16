import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import {
  ruleSchema,
  storedRuleSchema,
  type RuleInput,
} from "../../../shared/contracts";
import type { Summary } from "../../../shared/domain";
import { request } from "../../client/api";
import { Dialog } from "./Dialog";

export const RuleDialog = ({
  data,
  close,
}: {
  data: Summary;
  close: () => void;
}) => {
  const cache = useQueryClient();
  const [formError, setFormError] = useState("");
  const mutation = useMutation({
    mutationFn: (body: RuleInput) =>
      request("/rules", "POST", body, storedRuleSchema),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["summary"] });
      await cache.invalidateQueries({ queryKey: ["activity"] });
      close();
    },
  });
  const submit = (event: {
    preventDefault(): void;
    currentTarget: HTMLFormElement;
  }) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = ruleSchema.safeParse({
      serviceId: form.get("serviceId"),
      metric: form.get("metric"),
      threshold: Number(form.get("threshold")),
      severity: form.get("severity"),
      enabled: true,
      windowSeconds: Number(form.get("windowSeconds")),
      allowedLatenessSeconds: Number(form.get("lateness")),
      minSamples: Number(form.get("minSamples")),
      aggregation: form.get("aggregation"),
    });
    if (!parsed.success) {
      setFormError(
        parsed.error.issues.map((issue) => issue.message).join("; "),
      );
      return;
    }
    setFormError("");
    mutation.mutate(parsed.data);
  };
  return (
    <Dialog
      close={close}
      labelledBy="rule-heading"
      className="dialog"
      overlayClassName="overlay centered"
    >
      <div className="section-heading">
        <h2 id="rule-heading">Create alert rule</h2>
        <button
          className="icon-button"
          aria-label="Close rule dialog"
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      <p className="muted">
        Evaluate each incoming event and correlate matching alerts into the open
        incident.
      </p>
      <form onSubmit={submit}>
        <label>
          Service
          <select name="serviceId">
            {data.services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Metric
          <select name="metric">
            <option value="error_rate">Error rate (%)</option>
            <option value="latency">Latency (ms)</option>
          </select>
        </label>
        <label>
          Greater than
          <input
            type="number"
            name="threshold"
            min="0"
            step="0.1"
            defaultValue="5"
            required
          />
        </label>
        <label>
          Incident severity
          <select name="severity">
            <option>P1</option>
            <option>P2</option>
            <option>P3</option>
          </select>
        </label>
        <label>
          Window (seconds; 0 = immediate)
          <input
            name="windowSeconds"
            type="number"
            min="0"
            max="3600"
            defaultValue="0"
          />
        </label>
        <label>
          Allowed lateness (seconds)
          <input
            name="lateness"
            type="number"
            min="0"
            max="300"
            defaultValue="30"
          />
        </label>
        <label>
          Minimum samples
          <input
            name="minSamples"
            type="number"
            min="1"
            max="10000"
            defaultValue="2"
          />
        </label>
        <label>
          Aggregation
          <select name="aggregation">
            <option value="avg">Average</option>
            <option value="max">Maximum</option>
            <option value="all">Every sample</option>
          </select>
        </label>
        {(formError || mutation.error) && (
          <p className="error-box">{formError || mutation.error?.message}</p>
        )}
        <button className="primary" disabled={mutation.isPending}>
          <Plus size={16} />
          Create rule
        </button>
      </form>
    </Dialog>
  );
};
