import { useQueryClient, useMutation } from "@tanstack/react-query";
import { storedRuleSchema } from "../../../../shared/contracts";
import { request } from "../../../client/api";

export const RuleToggle = ({
  id,
  enabled,
  onError,
}: {
  id: string;
  enabled: boolean;
  onError: (message: string) => void;
}) => {
  const cache = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      request(`/rules/${id}`, "PATCH", { enabled: !enabled }, storedRuleSchema),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["summary"] });
      void cache.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (error) => onError(error.message),
  });
  return (
    <button
      role="switch"
      aria-checked={enabled}
      aria-label={`Enable rule ${id}`}
      className={`toggle ${enabled ? "on" : ""}`}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      <span />
    </button>
  );
};
