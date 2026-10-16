import type { ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { z } from "zod";
import { request } from "../../../client/api";

export type PageQuery = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
};

export type Mutate = (path: string, body: unknown) => Promise<void>;

export const text = (v: unknown) =>
  typeof v === "string" ? v : String(v ?? "");

export const when = (iso: string) => {
  const at = Date.parse(iso);
  return Number.isNaN(at)
    ? iso
    : new Date(at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};

export const useOps = <T extends Record<string, unknown>>(
  path: string,
  refresh: number,
  schema: z.ZodType<{ items: T[]; nextCursor?: string | null }>,
) =>
  useInfiniteQuery({
    queryKey: ["operations", path],
    queryFn: ({ pageParam }) =>
      request(
        `${path}${path.includes("?") ? "&" : "?"}limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        "GET",
        undefined,
        schema,
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: refresh,
  });

export const list = <T,>(q: { data?: { pages: { items: T[] }[] } }) =>
  q.data?.pages.flatMap((p) => p.items) ?? [];

export const More = (q: PageQuery) =>
  q.hasNextPage ? (
    <button
      className="text-button"
      disabled={q.isFetchingNextPage}
      onClick={() => void q.fetchNextPage()}
    >
      Load more
    </button>
  ) : null;

export const Card = ({
  icon,
  title,
  meta,
  action,
  children,
  wide,
}: {
  icon: ReactNode;
  title: string;
  meta: string;
  action?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) => (
  <article className={`ops-card${wide ? " ops-span" : ""}`}>
    <header className="ops-card-head">
      <span className="ops-icon">{icon}</span>
      <div>
        <h3>{title}</h3>
        <span className="muted">{meta}</span>
      </div>
      {action}
    </header>
    {children}
  </article>
);

export const Empty = ({ label }: { label: string }) => (
  <div className="ops-empty muted">{label}</div>
);
