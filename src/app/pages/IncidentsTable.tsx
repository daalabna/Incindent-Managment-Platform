import { ArrowRight, ListFilter, Search, ShieldCheck } from "lucide-react";
import { useIncidents } from "../../client/api";
import { age, labels } from "../lib/format";

export const IncidentsTable = ({
  activeCount,
  filter,
  query,
  onFilter,
  onQuery,
  onOpen,
  onSimulate,
}: {
  activeCount: number;
  filter: string;
  query: string;
  onFilter: (filter: string) => void;
  onQuery: (query: string) => void;
  onOpen: (id: string) => void;
  onSimulate: () => void;
}) => {
  const status = filter === "resolved" || filter === "all" ? filter : "active";
  const pages = useIncidents(status, query);
  const visible = pages.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="section incident-section">
      <div className="section-heading">
        <h2>
          Incidents <span className="count">{visible.length}</span>
        </h2>
        <span className="muted">
          <span className="dot green" /> Updated in real time
        </span>
      </div>
      <div className="panel">
        <div className="table-toolbar">
          <div className="tabs">
            {["active", "resolved", "all"].map((value) => (
              <button
                className={filter === value ? "active" : ""}
                onClick={() => onFilter(value)}
                key={value}
              >
                {value === "active"
                  ? "Active"
                  : value === "all"
                    ? "All incidents"
                    : "Resolved"}
                {value === "active" && <span>{activeCount}</span>}
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={15} />
            <input
              placeholder="Search incidents…"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
            />
            <ListFilter size={15} />
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Incident</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((incident) => (
                <tr key={incident.id}>
                  <td>
                    <button
                      className="incident-title"
                      onClick={() => onOpen(incident.id)}
                    >
                      {incident.title}
                    </button>
                    <div className="incident-meta">
                      {incident.id}
                      <span>·</span>
                      {incident.serviceId}
                      <span>·</span>
                      {incident.alerts} correlated alerts
                    </div>
                  </td>
                  <td>
                    <span className={`severity ${incident.severity}`}>
                      {incident.severity === "P1" && <span className="dot" />}
                      {incident.severity}
                    </span>
                  </td>
                  <td>
                    <span className={`status ${incident.status}`}>
                      <span className="dot" />
                      {labels[incident.status]}
                    </span>
                  </td>
                  <td>
                    <span className="assignee">
                      {incident.assignee ? (
                        <>
                          <span className="tiny-avatar">
                            {incident.assignee.slice(0, 2).toUpperCase()}
                          </span>
                          {incident.assignee}
                        </>
                      ) : (
                        <span className="muted">Unassigned</span>
                      )}
                    </span>
                  </td>
                  <td className="muted">{age(incident.createdAt)}</td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Open ${incident.id}`}
                      onClick={() => onOpen(incident.id)}
                    >
                      <ArrowRight size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!visible.length && (
          <div className="empty">
            <span>
              <ShieldCheck size={28} />
            </span>
            <h3>
              {pages.isPending
                ? "Loading incidents…"
                : pages.isError
                  ? "Incidents could not be loaded"
                  : query
                    ? "No matching incidents"
                    : filter === "resolved"
                      ? "No resolved incidents yet"
                      : "Looking good. Nothing to investigate."}
            </h3>
            <p>
              {query
                ? "Try a different title or incident ID."
                : "Run a simulation to see alerts correlate into an incident."}
            </p>
            {!query && (
              <button className="text-button" onClick={onSimulate}>
                Start a simulation <ArrowRight size={14} />
              </button>
            )}
          </div>
        )}
        <div className="table-footer">
          {visible.length} incident{visible.length === 1 ? "" : "s"}
          {pages.hasNextPage ? (
            <button
              className="text-button"
              onClick={() => void pages.fetchNextPage()}
              disabled={pages.isFetchingNextPage}
            >
              Load more <ArrowRight size={14} />
            </button>
          ) : (
            <span>Open incident on the same service stays correlated</span>
          )}
        </div>
      </div>
    </section>
  );
};
