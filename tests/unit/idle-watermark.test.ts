import { expect, it } from "vitest";
import { nextIdleWatermark } from "../../server/db/idle-watermark";

it("advances a silent stream and leaves an active stream on its event watermark", () => {
  expect(nextIdleWatermark(1_000, 1_000, 5_000, 1_000)).toBe(4_000);
  expect(nextIdleWatermark(4_500, 3_500, 5_000, 1_000)).toBe(3_500);
  expect(nextIdleWatermark(1_000, 4_500, 5_000, 1_000)).toBe(4_500);
});
