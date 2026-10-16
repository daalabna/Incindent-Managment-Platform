import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Bell,
  ChevronDown,
  CircleHelp,
  Clock3,
  LayoutDashboard,
  LoaderCircle,
  Plus,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import { messageSchema } from "../../shared/contracts";
import { request, useRealtime, useSummary } from "../client/api";
import { useUI, type Page } from "./lib/store";
import { IncidentDrawer } from "./components/IncidentDrawer";
import { RuleDialog } from "./components/RuleDialog";
import { ActivityPage } from "./pages/ActivityPage";
import { IncidentsTable } from "./pages/IncidentsTable";
import { OverviewFooter, OverviewPage } from "./pages/OverviewPage";
import { RulesPage } from "./pages/RulesPage";
import { ServicesPage } from "./pages/ServicesPage";
import { OperationsPage } from "./pages/OperationsPage";
import { session } from "../client/session";

const nav: Array<{ name: Page; icon: typeof LayoutDashboard }> = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Incidents", icon: TriangleAlert },
  { name: "Services", icon: Server },
  { name: "Alert rules", icon: SlidersHorizontal },
  { name: "Activity log", icon: Clock3 },
  { name: "Operations", icon: Terminal },
];

const descriptions: Record<Page, string> = {
  Overview: "A clear view of your services. A faster path to resolution.",
  Incidents: "From the first alert to the final resolution.",
  Services: "Health and performance across your service catalog.",
  "Alert rules": "Turn monitoring signals into actionable incidents.",
  "Activity log": "Every change, with the context you need.",
  Operations: "Delivery, dependencies, notifications and runbook execution.",
};

export const App = () => {
  const { data, isPending, error } = useSummary();
  const online = useRealtime();
  const cache = useQueryClient();
  const { page, selectPage, selected, selectIncident } = useUI();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("active");
  const [notice, setNotice] = useState("");
  const [ruleOpen, setRuleOpen] = useState(false);
  const simulate = useMutation({
    mutationFn: () => request("/simulations", "POST", undefined, messageSchema),
    onSuccess: () => {
      setNotice("Simulation started. Watch Search alerts arrive in real time.");
      void cache.invalidateQueries({ queryKey: ["summary"] });
    },
    onError: (failure) => setNotice(failure.message),
  });
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  const active =
    data?.incidents.filter((incident) => incident.status !== "resolved") ?? [];
  const healthy =
    data?.services.filter((service) => service.health === "healthy").length ??
    0;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Sentinel home">
          <span className="brand-mark">
            <ShieldCheck size={24} />
          </span>
          sentinel<span className="brand-dot">.</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">S</span>
          <div>
            Sentinel workspace<small>Local development</small>
          </div>
          <span className="local-dot" />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={page === name ? "nav-item selected" : "nav-item"}
              onClick={() => selectPage(name)}
            >
              <Icon size={18} />
              {name}
              {name === "Incidents" && active.length > 0 && (
                <span className="nav-count">{active.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-callout">
          <span className="callout-icon">
            <Terminal size={20} />
          </span>
          <strong>
            Your next incident,
            <br />
            under control.
          </strong>
          <p>Try a real event pipeline in your local workspace.</p>
          <button
            onClick={() => simulate.mutate()}
            disabled={simulate.isPending}
          >
            Run a simulation <ArrowRight size={15} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <span>
            <span className={`dot ${online ? "green" : "amber"}`} />
            {online ? "Live connection" : "Reconnecting…"}
          </span>
          <div className="profile">
            <span className="avatar">LO</span>
            <div>
              {session.username}
              <small>
                {session.tenant} · {session.role}
              </small>
            </div>
          </div>
          {!session.demo && (
            <button
              className="text-button"
              onClick={() =>
                void request("/auth/logout", "POST", undefined, messageSchema)
                  .then(() =>
                    window.dispatchEvent(new Event("session-expired")),
                  )
                  .catch((error) => setNotice(error.message))
              }
            >
              Sign out
            </button>
          )}
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>{page}</strong>
          </div>
          <div className="topbar-right">
            <span className="environment">
              <span className="dot green" /> Local demo{" "}
              <ChevronDown size={12} />
            </span>
            <button
              className="icon-button"
              aria-label="Show activity log"
              onClick={() => selectPage("Activity log")}
            >
              <Bell size={18} />
              {active.length > 0 && <i />}
            </button>
            <span className="top-avatar">LO</span>
          </div>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR OPERATIONS, AT A GLANCE</div>
              <h1>{page === "Overview" ? "System overview" : page}</h1>
              <p>{descriptions[page]}</p>
            </div>
            <button
              className="primary"
              onClick={() =>
                page === "Alert rules" ? setRuleOpen(true) : simulate.mutate()
              }
              disabled={simulate.isPending}
            >
              {page === "Alert rules" ? <Plus size={16} /> : <Zap size={16} />}{" "}
              {page === "Alert rules" ? "Create rule" : "Simulate incident"}
            </button>
          </div>
          {isPending ? (
            <div className="loading">
              <LoaderCircle className="spin" />
              Connecting to Sentinel…
            </div>
          ) : error ? (
            <div className="error-box">
              Could not connect to the API: {error.message}. Start the project
              with npm run dev.
            </div>
          ) : (
            data && (
              <>
                {page === "Overview" && (
                  <OverviewPage
                    data={data}
                    healthy={healthy}
                    activeCount={active.length}
                    onServices={() => selectPage("Services")}
                  />
                )}
                {(page === "Overview" || page === "Incidents") && (
                  <IncidentsTable
                    activeCount={active.length}
                    filter={filter}
                    query={query}
                    onFilter={setFilter}
                    onQuery={setQuery}
                    onOpen={selectIncident}
                    onSimulate={() => simulate.mutate()}
                  />
                )}
                {page === "Overview" && (
                  <OverviewFooter
                    data={data}
                    onActivity={() => selectPage("Activity log")}
                    onSimulate={() => simulate.mutate()}
                  />
                )}
                {page === "Services" && (
                  <ServicesPage services={data.services} />
                )}
                {page === "Alert rules" && (
                  <RulesPage data={data} onError={setNotice} />
                )}
                {page === "Activity log" && <ActivityPage />}
                {page === "Operations" && <OperationsPage />}
                <footer className="footer">
                  <span>
                    <ShieldCheck size={14} /> Sentinel <span>·</span> Local
                    development workspace
                  </span>
                  <span>
                    <CircleHelp size={14} /> Documentation in README.md
                  </span>
                </footer>
              </>
            )
          )}
        </main>
      </div>
      {notice && (
        <div role="status" className="toast">
          <Activity size={18} />
          {notice}
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {selected && (
        <IncidentDrawer id={selected} close={() => selectIncident(null)} />
      )}
      {ruleOpen && data && (
        <RuleDialog data={data} close={() => setRuleOpen(false)} />
      )}
    </div>
  );
};
