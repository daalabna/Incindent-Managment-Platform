import type { ZodType, ZodTypeDef } from "zod";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
  activityPageSchema,
  incidentPageSchema,
  incidentSchema,
  summarySchema,
  timelineEntrySchema,
  type ActivityPage,
  type SummaryResponse,
} from "../../shared/contracts";
import { session } from "./session";

const timelinePageSchema = z.object({
  items: z.array(timelineEntrySchema.extend({ sequence: z.string() })),
  nextCursor: z.string().nullable(),
});

const noticeScopes = ["summary", "activity", "incident"] as const;
type NoticeScope = (typeof noticeScopes)[number];

/** Output type T may differ from schema input (e.g. Zod defaults). */
export const request = async <T>(
  path: string,
  method = "GET",
  body: unknown,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> => {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(session.csrf ? { "x-csrf-token": session.csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    const error: unknown = await response.json().catch(() => ({}));
    const message =
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  const payload: unknown = await response.json();
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new Error("The API response did not match the expected contract");
  return parsed.data;
};

const isScope = (value: unknown): value is NoticeScope =>
  noticeScopes.some((scope) => scope === value);

export const readNotice = (
  body: unknown,
): { scopes: NoticeScope[]; incidentId: string | null } => {
  const fallback = { scopes: [...noticeScopes], incidentId: null };
  if (!body || typeof body !== "object") return fallback;
  const scopes =
    "scopes" in body && Array.isArray(body.scopes)
      ? body.scopes.filter(isScope)
      : fallback.scopes;
  const incidentId =
    "incidentId" in body && typeof body.incidentId === "string"
      ? body.incidentId
      : null;
  return { scopes: scopes.length ? scopes : fallback.scopes, incidentId };
};

export const invalidateNotice = (
  cache: QueryClient,
  notice: { scopes: readonly NoticeScope[]; incidentId: string | null },
) => {
  if (notice.scopes.includes("summary")) {
    void cache.invalidateQueries({ queryKey: ["summary"] });
    void cache.invalidateQueries({ queryKey: ["incidents"] });
  }
  if (notice.scopes.includes("activity"))
    void cache.invalidateQueries({ queryKey: ["activity"] });
  if (!notice.scopes.includes("incident")) return;
  void cache.invalidateQueries({
    queryKey: notice.incidentId
      ? ["incident-timeline", notice.incidentId]
      : ["incident-timeline"],
  });
  if (notice.incidentId)
    void cache.invalidateQueries({ queryKey: ["incident", notice.incidentId] });
  else void cache.invalidateQueries({ queryKey: ["incident"] });
};

export const useSummary = () => {
  return useQuery({
    queryKey: ["summary"],
    queryFn: () => request("/summary", "GET", undefined, summarySchema),
    refetchInterval: 15000,
  });
};

export const useIncident = (id: string | null) => {
  return useQuery({
    queryKey: ["incident", id],
    queryFn: () =>
      request(
        `/incidents/${id}?timeline=none`,
        "GET",
        undefined,
        incidentSchema,
      ),
    enabled: Boolean(id),
    refetchInterval: 15000,
  });
};

export const useIncidentTimeline = (id: string | null) =>
  useInfiniteQuery({
    queryKey: ["incident-timeline", id],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "50" });
      if (pageParam) params.set("before", pageParam);
      return request(
        `/incidents/${id}/timeline?${params}`,
        "GET",
        undefined,
        timelinePageSchema,
      );
    },
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(id),
    refetchInterval: 15000,
  });

export const useIncidents = (
  status: "active" | "resolved" | "all",
  q: string,
) => {
  return useInfiniteQuery({
    queryKey: ["incidents", status, q],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "50", status });
      if (pageParam) params.set("cursor", pageParam);
      if (q.trim()) params.set("q", q.trim());
      return request(
        `/incidents?${params}`,
        "GET",
        undefined,
        incidentPageSchema,
      );
    },
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 15000,
  });
};

export const useActivity = (enabled: boolean) => {
  return useQuery({
    queryKey: ["activity"],
    queryFn: () =>
      request<ActivityPage>(
        "/activity?limit=300",
        "GET",
        undefined,
        activityPageSchema,
      ),
    enabled,
    refetchInterval: 15000,
  });
};

export const useRealtime = () => {
  const cache = useQueryClient();
  const [online, setOnline] = useState(false);
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      );
      socket.onopen = () => {
        setOnline(true);
        invalidateNotice(cache, { scopes: noticeScopes, incidentId: null });
      };
      socket.onmessage = (event) => {
        try {
          invalidateNotice(cache, readNotice(JSON.parse(String(event.data))));
        } catch {
          invalidateNotice(cache, { scopes: noticeScopes, incidentId: null });
        }
      };
      socket.onclose = () => {
        setOnline(false);
        if (!disposed) timer = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket.close();
    };
  }, [cache]);
  return online;
};

export type { SummaryResponse };
