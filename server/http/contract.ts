import type { ZodType } from "zod";
import { DomainError } from "../domain/errors";

export const contract = <T>(schema: ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
    .join("; ");
  throw new DomainError(`Response did not match the contract: ${details}`, 500);
};
