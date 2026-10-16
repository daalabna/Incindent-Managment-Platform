import { readConfig } from "../server/config";
import { createProvider } from "../server/ai/provider";

// Explicit, billable smoke check; synthetic data only, never part of npm test.
const config = readConfig().ai!;
try {
  const output = await createProvider(config)(
    {
      incidentId: "SMOKE-1",
      incidentVersion: 1,
      sources: [
        {
          id: "incident:SMOKE-1",
          kind: "incident",
          label: "Synthetic incident",
          text: "Synthetic test: search latency rose to 2000 ms. One alert, no deployment or application logs. No recovery action recorded.",
        },
      ],
      limitations: ["Synthetic fixture, no real customer data."],
    },
    config.model,
  );
  console.log(
    JSON.stringify({
      status: "ok",
      model: config.model,
      inputTokens: output.inputTokens,
      outputTokens: output.outputTokens,
      estimatedCostUsd: output.estimatedCostUsd,
      facts: output.result.facts.length,
      hypotheses: output.result.hypotheses.length,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "AI smoke failed");
  process.exitCode = 1;
}
