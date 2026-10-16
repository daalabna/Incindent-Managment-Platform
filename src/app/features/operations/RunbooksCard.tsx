import { PlayCircle } from "lucide-react";
import { Card, More, text, type Mutate, type PageQuery } from "./ui";

const recovery = {
  name: "Investigate and verify recovery",
  timeoutSeconds: 300,
  steps: [
    { type: "assign" as const, assignee: "Local operator" },
    { type: "note" as const, text: "Investigation started" },
    { type: "wait" as const, seconds: 5 },
    { type: "check_health" as const, serviceId: "search-api", retrySeconds: 5 },
    { type: "notify" as const, text: "Recovery verified" },
  ],
};

export const RunbooksCard = ({
  books,
  query,
  mutate,
}: {
  books: { id: unknown; name: unknown }[];
  query: PageQuery;
  mutate: Mutate;
}) => (
  <Card
    wide
    icon={<PlayCircle size={18} />}
    title="Runbooks"
    meta={`${books.length} defined`}
    action={
      <button
        className="secondary"
        onClick={() => void mutate("/runbooks", recovery)}
      >
        Create recovery runbook
      </button>
    }
  >
    <form
      className="ops-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void mutate("/runbook-runs", {
          runbookId: f.get("book"),
          incidentId: f.get("incident"),
        });
      }}
    >
      <label>
        Runbook
        <select name="book" required disabled={!books.length}>
          {books.length ? (
            books.map((b) => (
              <option key={text(b.id)} value={text(b.id)}>
                {text(b.name)}
              </option>
            ))
          ) : (
            <option value="">No runbooks</option>
          )}
        </select>
      </label>
      <label>
        Incident ID
        <input name="incident" placeholder="INC-1001" required />
      </label>
      <button className="primary" disabled={!books.length}>
        Start runbook
      </button>
    </form>
    <More {...query} />
  </Card>
);
