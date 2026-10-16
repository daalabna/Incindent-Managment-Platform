import { z } from "zod";

export const promptVersion = "incident-v6";
const schema = z.object({
  AI_ENABLED: z.enum(["true", "false"]).default("false"),
  OPENAI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().min(1).default("gpt-4.1-mini-2025-04-14"),
  AI_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(1).max(10000).default(50),
});
export type AiConfig = {
  enabled: boolean;
  apiKey?: string;
  model: string;
  dailyLimit: number;
};
export const readAiConfig = (): AiConfig => {
  const env = schema.parse(process.env);
  return {
    enabled: env.AI_ENABLED === "true",
    apiKey: env.OPENAI_API_KEY,
    model: env.AI_MODEL,
    dailyLimit: env.AI_DAILY_REQUEST_LIMIT,
  };
};
