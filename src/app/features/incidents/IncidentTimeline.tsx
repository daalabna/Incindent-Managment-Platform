import { Check, Radio } from "lucide-react";
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import type { TimelineEntry } from "../../../../shared/domain";
import { time } from "../../lib/format";

type TimelinePage = { items: TimelineEntry[] };

export const IncidentTimeline = ({
  query,
}: {
  query: UseInfiniteQueryResult<InfiniteData<TimelinePage>, Error>;
}) => {
  const timelineEntries = [
    ...(query.data?.pages.flatMap((page) => page.items) ?? []),
  ].reverse();
  return (
    <>
      <h3 className="timeline-heading">
        Incident timeline{" "}
        <span className="live-tag">
          <Radio size={12} />{" "}
          {query.isError ? "Unavailable" : query.isPending ? "Loading" : "Live"}
        </span>
      </h3>
      {query.isError && (
        <div role="alert">
          <p>
            Unable to load incident history.
            {timelineEntries.length > 0
              ? " Showing previously loaded updates; they may be outdated."
              : ""}
          </p>
          <button
            className="secondary"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry history
          </button>
        </div>
      )}
      {query.isPending && <p role="status">Loading incident history…</p>}
      <div className="timeline">
        {timelineEntries.map((entry, index) => (
          <div className="timeline-item" key={entry.id}>
            <span
              className={`timeline-point ${index === timelineEntries.length - 1 ? "latest" : ""}`}
            >
              <Check size={11} />
            </span>
            <time>{time(entry.at)}</time>
            <strong>{entry.text}</strong>
            <small>{entry.actor}</small>
          </div>
        ))}
      </div>
      {query.hasNextPage && (
        <button
          className="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load earlier updates"}
        </button>
      )}
    </>
  );
};
