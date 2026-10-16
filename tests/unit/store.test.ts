import { afterEach, describe, expect, it } from "vitest";
import {
  listIncidents,
  refreshServices,
  toSummary,
} from "../../server/domain/apply";
import { Store } from "../../server/db/store";
import { randomUUID } from "node:crypto";
import type { MonitoringEvent } from "../../shared/domain";
const stores: Store[] = [];
const setup = () => {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
};
const event = (patch: Partial<MonitoringEvent> = {}): MonitoringEvent => ({
  id: randomUUID(),
  source: "search-api",
  type: "error_rate",
  value: 12.8,
  timestamp: new Date().toISOString(),
  ...patch,
});
afterEach(() => {
  stores.forEach((s) => s.close());
  stores.length = 0;
});
describe("incident pipeline", () => {
  it("correlates alerts across metrics and escalates severity", () => {
    const s = setup();
    s.ingest(event({ type: "latency", value: 1800 }));
    s.ingest(event());
    expect(s.state.incidents).toHaveLength(1);
    expect(s.state.incidents[0]).toMatchObject({
      severity: "P1",
      alerts: 2,
      version: 2,
    });
  });
  it("deduplicates event IDs without changing timeline or count", () => {
    const s = setup();
    const e = event();
    s.ingest(e);
    const before = structuredClone(s.state);
    expect(s.ingest(e)).toEqual({ duplicate: true });
    expect(s.state).toEqual(before);
  });
  it("rejects stale writes and illegal transitions atomically", () => {
    const s = setup();
    s.ingest(event());
    const i = s.state.incidents[0];
    s.update(i.id, 1, { assignee: "Operator" });
    expect(() => s.update(i.id, 1, { status: "acknowledged" })).toThrow(
      "Incident changed",
    );
    const before = structuredClone(s.state);
    expect(() => s.update(i.id, 2, { status: "resolved" })).toThrow(
      "Invalid transition",
    );
    expect(s.state).toEqual(before);
  });
  it("resolves via valid lifecycle and creates a new incident for later alerts", () => {
    const s = setup();
    s.ingest(event());
    const i = s.state.incidents[0];
    s.update(i.id, 1, { status: "acknowledged" });
    s.update(i.id, 2, { status: "investigating" });
    s.update(i.id, 3, { status: "resolved" });
    expect(i.resolvedAt).toBeTruthy();
    s.ingest(event());
    expect(s.state.incidents).toHaveLength(2);
  });
  it("correlates later alerts into the open incident and keeps other services separate", () => {
    const s = setup();
    s.ingest(event());
    const incident = s.state.incidents[0];
    if (!incident) throw new Error("missing incident");
    incident.createdAt = new Date(Date.now() - 301000).toISOString();
    s.ingest(event());
    s.ingest(event({ source: "payments" }));
    expect(s.state.incidents).toHaveLength(2);
    expect(
      s.state.incidents.find((item) => item.serviceId === "search-api")?.alerts,
    ).toBe(2);
  });
  it("keeps an explicit outage ahead of a later healthy metric", () => {
    const s = setup();
    s.ingest(event({ type: "health", value: 1 }));
    s.ingest(event({ type: "latency", value: 50 }));
    expect(
      s.state.services.find((service) => service.id === "search-api")?.health,
    ).toBe("outage");
  });
  it("does not let a passing health check hide a high error rate", () => {
    const s = setup();
    s.ingest(event());
    s.ingest(event({ type: "health", value: 0 }));
    expect(
      s.state.services.find((service) => service.id === "search-api")?.health,
    ).toBe("degraded");
  });
  it("keeps a newer metric but still counts an older breach while the service is degraded", () => {
    const s = setup();
    s.ingest(event({ value: 12.8 }), 2);
    s.ingest(event({ value: 9 }), 1);
    const service = s.state.services.find((item) => item.id === "search-api");
    expect(service?.errorRate).toBe(12.8);
    expect(s.state.incidents[0]?.alerts).toBe(2);
  });
  it("does not open another incident from a stale breach after resolution", () => {
    const s = setup();
    s.ingest(event({ value: 12.8 }), 2);
    const incident = s.state.incidents[0];
    if (!incident) throw new Error("missing incident");
    s.update(incident.id, incident.version, { status: "acknowledged" });
    s.update(incident.id, incident.version, { status: "investigating" });
    s.update(incident.id, incident.version, { status: "resolved" });
    s.ingest(event({ value: 9 }), 1);
    expect(
      s.state.services.find((item) => item.id === "search-api")?.errorRate,
    ).toBe(12.8);
    expect(s.state.incidents).toHaveLength(1);
    expect(s.state.incidents[0]?.status).toBe("resolved");
  });
  it("does not apply an older observation over a newer metric", () => {
    const s = setup();
    s.ingest(event({ type: "latency", value: 50 }), 2);
    s.ingest(event({ type: "latency", value: 2000 }), 1);
    const service = s.state.services.find((item) => item.id === "search-api");
    expect(service?.latency).toBe(50);
    expect(service?.health).toBe("healthy");
    expect(s.state.incidents).toHaveLength(0);
  });
  it("marks a service unknown when every signal is stale", () => {
    const s = setup();
    s.ingest(event({ type: "latency", value: 50 }));
    const service = s.state.services.find((item) => item.id === "search-api");
    const observation = service?.observations.latency;
    if (!observation) throw new Error("missing observation");
    observation.at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    refreshServices(s.state);
    expect(
      s.state.services.find((item) => item.id === "search-api")?.health,
    ).toBe("unknown");
  });
  it("rejects a reused event id when the payload differs", () => {
    const s = setup();
    const first = event({ id: "same-event", value: 12.8 });
    s.ingest(first);
    expect(() => s.ingest({ ...first, source: "payments" })).toThrow(
      /different event/,
    );
    expect(s.ingest(first)).toEqual({ duplicate: true });
    expect(s.state.events).toHaveLength(1);
  });
  it("keeps an open incident visible when resolved history fills the first page", () => {
    const s = setup();
    s.state.incidents = [
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `INC-${2000 - index}`,
        title: "Resolved later",
        serviceId: "search-api",
        severity: "P2" as const,
        status: "resolved" as const,
        assignee: null,
        assigneeEpoch: 0,
        alerts: 1,
        version: 1,
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
        resolvedAt: new Date(Date.UTC(2026, 0, 3)).toISOString(),
        timeline: [],
      })),
      {
        id: "INC-1001",
        title: "Hidden open",
        serviceId: "payments",
        severity: "P1" as const,
        status: "triggered" as const,
        assignee: null,
        assigneeEpoch: 0,
        alerts: 1,
        version: 1,
        createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        resolvedAt: null,
        timeline: [],
      },
    ];
    expect(
      listIncidents(s.state, 50).items.some((item) => item.id === "INC-1001"),
    ).toBe(false);
    expect(
      listIncidents(s.state, 50, undefined, "active").items.map(
        (item) => item.id,
      ),
    ).toEqual(["INC-1001"]);
    expect(
      listIncidents(s.state, 50, undefined, "all", "Hidden open").items.map(
        (item) => item.id,
      ),
    ).toEqual(["INC-1001"]);
    expect(toSummary(s.state).incidents.map((item) => item.id)).toEqual([
      "INC-1001",
    ]);
    expect(toSummary(s.state).resolvedCount).toBe(50);
    expect(() =>
      listIncidents(s.state, 50, "2026-99-01T00:00:00.000Z|INC-1"),
    ).toThrow(/Invalid cursor/);
    expect(() =>
      listIncidents(s.state, 50, "2026-02-31T00:00:00.000Z|INC-1"),
    ).toThrow(/Invalid cursor/);
  });
  it("counts accepted events beyond the retained history", () => {
    const s = setup();
    for (let index = 0; index < 201; index += 1)
      s.ingest(event({ id: `event-${index}`, value: 0 }));
    expect(s.state.events).toHaveLength(200);
    expect(toSummary(s.state).eventCount).toBe(201);
  });
  it("does not trigger disabled rules", () => {
    const s = setup();
    s.toggleRule("rule-search-errors", false);
    s.ingest(event());
    expect(s.state.incidents).toHaveLength(0);
  });
});
