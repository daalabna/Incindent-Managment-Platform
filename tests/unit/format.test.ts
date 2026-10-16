import { expect, it } from "vitest";
import { formatErrorRate } from "../../shared/format";

it("renders only finite error rates", () => {
  expect(formatErrorRate(12.34)).toBe("12.3");
  expect(formatErrorRate(null)).toBe("—");
  expect(formatErrorRate(Number.POSITIVE_INFINITY)).toBe("—");
});
