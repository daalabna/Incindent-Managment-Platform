import { expect, it } from "vitest";
import { readNotice } from "../../src/client/api";

it("keeps a service update from refreshing every open incident", () => {
  expect(
    readNotice({ scopes: ["summary", "activity"], incidentId: null }),
  ).toEqual({
    scopes: ["summary", "activity"],
    incidentId: null,
  });
});

it("refreshes only the incident named in the notice", () => {
  expect(
    readNotice({
      scopes: ["summary", "activity", "incident"],
      incidentId: "INC-1001",
    }),
  ).toEqual({
    scopes: ["summary", "activity", "incident"],
    incidentId: "INC-1001",
  });
});

it("falls back to a full refresh when the notice is malformed", () => {
  expect(readNotice("not-json")).toEqual({
    scopes: ["summary", "activity", "incident"],
    incidentId: null,
  });
});
