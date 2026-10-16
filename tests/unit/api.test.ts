import { expect, it } from "vitest";
import { createApp } from "../../server/http/app";
it("assigns the incident to the current operator", async () => {
  const { app } = await createApp();
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: { source: "search-api", type: "error_rate", value: 12 },
    });
    const assigned = await app.inject({
      method: "POST",
      url: `/api/incidents/${created.json().incidentId}/assign-me`,
      payload: { version: 1 },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().assignee).toBe("Local operator");
  } finally {
    await app.close();
  }
});
it("validates events, ingests, rejects conflicts and exposes durable changes", async () => {
  const { app } = await createApp();
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "search-api", type: "error_rate", value: -1 },
        })
      ).statusCode,
    ).toBe(400);
    const result = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: { source: "search-api", type: "error_rate", value: 12 },
    });
    expect(result.statusCode).toBe(200);
    const id = result.json().incidentId;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/incidents/${id}`,
          payload: { version: 1, status: "acknowledged" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/incidents/${id}`,
          payload: { version: 1, status: "investigating" },
        })
      ).statusCode,
    ).toBe(409);
    const state = (await app.inject("/api/state")).json();
    expect(state.incidents[0].status).toBe("acknowledged");
    expect(state.incidents[0].timeline).toBeUndefined();
    expect(state.events).toBeUndefined();
    expect(state.resolvedCount).toEqual(expect.any(Number));
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/simulations",
          headers: { origin: "https://example.com" },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
it("rejects non-finite JSON numbers before they can be stored", async () => {
  const { app } = await createApp();
  try {
    const overflow = await app.inject({
      method: "POST",
      url: "/api/events",
      headers: { "content-type": "application/json", host: "localhost:80" },
      payload:
        '{"id":"overflow","source":"search-api","type":"error_rate","value":1e400}',
    });
    expect(overflow.statusCode).toBe(400);
    const rule = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { "content-type": "application/json", host: "localhost:80" },
      payload:
        '{"serviceId":"search-api","metric":"error_rate","threshold":1e400,"severity":"P1","enabled":true}',
    });
    expect(rule.statusCode).toBe(400);
    const state = (await app.inject("/api/state")).json();
    expect(state.events).toBeUndefined();
    expect(
      state.services.find(
        (service: { id: string }) => service.id === "search-api",
      ).errorRate,
    ).toBe(0);
  } finally {
    await app.close();
  }
});
it("rejects a host that only matches its own untrusted origin", async () => {
  const { app } = await createApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/events",
      headers: { host: "evil.example", origin: "http://evil.example" },
      payload: { source: "search-api", type: "error_rate", value: 1 },
    });
    expect(response.statusCode).toBe(403);
  } finally {
    await app.close();
  }
});
it("returns incident summaries separately from incident detail", async () => {
  const { app } = await createApp();
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "search-api", type: "error_rate", value: 12 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "payments", type: "error_rate", value: 9 },
        })
      ).statusCode,
    ).toBe(200);
    const page = await app.inject("/api/incidents?limit=1");
    expect(page.statusCode).toBe(200);
    expect(page.json().items).toHaveLength(1);
    expect(page.json().items[0].timeline).toBeUndefined();
    const cursor = encodeURIComponent(page.json().nextCursor);
    const next = await app.inject(`/api/incidents?limit=1&cursor=${cursor}`);
    expect(next.json().items).toHaveLength(1);
    const detail = await app.inject(
      `/api/incidents/${page.json().items[0].id}`,
    );
    expect(detail.json().timeline).toEqual([]);
    const detailFull = await app.inject(
      `/api/incidents/${page.json().items[0].id}?timeline=full`,
    );
    expect(detailFull.json().timeline.length).toBeGreaterThan(0);
    expect(
      (await app.inject("/api/incidents?cursor=not-a-cursor")).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject(
          `/api/incidents?cursor=${encodeURIComponent("2026-99-01T00:00:00.000Z|INC-1")}`,
        )
      ).statusCode,
    ).toBe(400);
    const summary = (await app.inject("/api/summary")).json();
    expect(summary.incidents[0].timeline).toBeUndefined();
    expect(
      summary.incidents.every(
        (incident: { status: string }) => incident.status !== "resolved",
      ),
    ).toBe(true);
    expect(summary.resolvedCount).toBe(0);
    expect(summary.eventCount).toBe(2);
    const target = page.json().items[0].id as string;
    const beforePatch = (
      await app.inject(`/api/incidents/${target}`)
    ).json() as {
      version: number;
      timeline: { text: string }[];
    };
    const beforeFull = (
      await app.inject(`/api/incidents/${target}?timeline=full`)
    ).json() as { timeline: { text: string }[] };
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/incidents/${target}`,
      payload: {
        version: beforePatch.version,
        status: "acknowledged",
        comment: "review-timeline-check",
      },
    });
    expect(patched.statusCode).toBe(200);
    const patchedBody = patched.json() as { timeline: { text: string }[] };
    // PATCH returns only rows inserted by this update.
    expect(patchedBody.timeline.length).toBeGreaterThanOrEqual(1);
    expect(
      patchedBody.timeline.some((entry) =>
        entry.text.includes("review-timeline-check"),
      ),
    ).toBe(true);
    const afterFull = (
      await app.inject(`/api/incidents/${target}?timeline=full`)
    ).json() as { timeline: { text: string }[] };
    expect(afterFull.timeline.length).toBeGreaterThanOrEqual(
      beforeFull.timeline.length + 1,
    );
    for (const status of ["investigating", "resolved"]) {
      const current = (await app.inject(`/api/incidents/${target}`)).json();
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/incidents/${target}`,
            payload: { version: current.version, status },
          })
        ).statusCode,
      ).toBe(200);
    }
    const active = (await app.inject("/api/incidents?status=active")).json();
    expect(
      active.items.map((incident: { id: string }) => incident.id),
    ).not.toContain(target);
    const found = (
      await app.inject(`/api/incidents?q=${encodeURIComponent(target)}`)
    ).json();
    expect(found.items.map((incident: { id: string }) => incident.id)).toEqual([
      target,
    ]);
    const after = (await app.inject("/api/summary")).json();
    expect(after.resolvedCount).toBe(1);
    expect(
      after.incidents.map((incident: { id: string }) => incident.id),
    ).not.toContain(target);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: {
        id: "conflict-event",
        source: "search-api",
        type: "error_rate",
        value: 1,
      },
    });
    expect(conflict.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/events",
          payload: {
            id: "conflict-event",
            source: "payments",
            type: "error_rate",
            value: 1,
          },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
});
