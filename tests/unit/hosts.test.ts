import { expect, it } from "vitest";
import { isAllowedHost } from "../../server/http/hosts";

it("allows loopback hosts and an explicit allowlist entry", () => {
  expect(isAllowedHost("127.0.0.1:5173")).toBe(true);
  expect(isAllowedHost("localhost:80")).toBe(true);
  expect(isAllowedHost("[::1]:4000")).toBe(true);
  expect(isAllowedHost("::1")).toBe(true);
  expect(isAllowedHost("evil.example")).toBe(false);
  expect(isAllowedHost("evil.example", ["evil.example"])).toBe(true);
  expect(isAllowedHost(undefined)).toBe(false);
});
