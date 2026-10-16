import { Activity, ArrowRight, Zap } from "lucide-react";
import type { Summary } from "../../../../shared/domain";
import { ActivityRow } from "../../components/ActivityRow";

export const OverviewFooter = ({
  data,
  onActivity,
  onSimulate,
}: {
  data: Summary;
  onActivity: () => void;
  onSimulate: () => void;
}) => (
  <div className="bottom-grid">
    <section className="panel activity-panel">
      <div className="section-heading">
        <h2>Recent activity</h2>
        <button className="text-button" onClick={onActivity}>
          View log <ArrowRight size={14} />
        </button>
      </div>
      {data.audit.length ? (
        data.audit
          .slice(0, 3)
          .map((entry) => (
            <ActivityRow key={entry.id} entry={entry} clock="relative" />
          ))
      ) : (
        <div className="quiet">
          <Activity size={19} />
          <p>
            Your workspace is ready.
            <br />
            <span>Activity will appear as events arrive.</span>
          </p>
        </div>
      )}
    </section>
    <section className="demo-card">
      <span className="demo-symbol">
        <Zap size={22} />
      </span>
      <div className="eyebrow">BUILT FOR THE UNEXPECTED</div>
      <h2>Practice before production.</h2>
      <p>
        Trigger a Search outage scenario and follow the signals from alert to
        resolution.
      </p>
      <button onClick={onSimulate}>
        Simulate production incident <ArrowRight size={16} />
      </button>
      <span className="demo-note">Local events. Real incident lifecycle.</span>
    </section>
  </div>
);
