import { expect, it } from "vitest";
import { cleanupResources } from "../support/cleanup";

it("runs every cleanup step and keeps the original failure available", async () => {
  const ran: string[] = [];
  const cleanupError = await cleanupResources([
    async () => {
      ran.push("rabbit");
      throw new Error("broker unavailable");
    },
    async () => {
      ran.push("database");
    },
  ]);
  expect(ran).toEqual(["rabbit", "database"]);
  expect(cleanupError).toBeInstanceOf(AggregateError);
  expect(cleanupError?.message).toContain("broker unavailable");
});
