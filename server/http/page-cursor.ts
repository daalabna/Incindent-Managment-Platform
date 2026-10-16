import { z } from "zod";
import { DomainError } from "../domain/errors";

const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const cursorSchema = z.object({
  at: z.string().regex(stamp),
  id: z.string().min(1).max(300),
  generation: z.number().int().nonnegative().optional(),
});
export type PageCursor = z.infer<typeof cursorSchema>;

export const encodePageCursor = (value: PageCursor) =>
  Buffer.from(JSON.stringify(cursorSchema.parse(value)), "utf8").toString(
    "base64url",
  );

export const decodePageCursor = (value?: string) => {
  if (!value) return null;
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new DomainError("Invalid cursor", 400);
  }
};
