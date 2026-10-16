ALTER TABLE monitoring_events ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE monitoring_events ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0;
ALTER TABLE monitoring_events ADD COLUMN IF NOT EXISTS deadline_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes');
ALTER TABLE monitoring_events ADD COLUMN IF NOT EXISTS terminal_at timestamptz;
ALTER TABLE monitoring_events ADD COLUMN IF NOT EXISTS trace_context jsonb;
ALTER TABLE monitoring_events ADD COLUMN IF NOT EXISTS fingerprint jsonb;
CREATE TABLE IF NOT EXISTS dead_letters (
  event_id text NOT NULL REFERENCES monitoring_events(id), generation integer NOT NULL,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), replayed_at timestamptz,
  PRIMARY KEY(event_id,generation)
);
CREATE TABLE IF NOT EXISTS metric_samples (
  event_id text PRIMARY KEY REFERENCES monitoring_events(id), service_id text NOT NULL REFERENCES services(id),
  metric text NOT NULL, value double precision NOT NULL, event_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS metric_samples_window ON metric_samples(service_id,metric,event_at);
CREATE TABLE IF NOT EXISTS stream_watermarks (
  service_id text NOT NULL REFERENCES services(id), metric text NOT NULL,
  max_event_at timestamptz NOT NULL, watermark timestamptz NOT NULL,
  PRIMARY KEY(service_id,metric)
);
CREATE TABLE IF NOT EXISTS service_dependencies (
  service_id text NOT NULL REFERENCES services(id), depends_on text NOT NULL REFERENCES services(id),
  PRIMARY KEY(service_id,depends_on), CHECK(service_id <> depends_on)
);
CREATE TABLE IF NOT EXISTS rule_evaluations (
  rule_id text PRIMARY KEY REFERENCES rules(id), finalized_at timestamptz
);
CREATE TABLE IF NOT EXISTS notification_jobs (
  id uuid PRIMARY KEY, incident_id text REFERENCES incidents(id), adapter text NOT NULL,
  payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
  error text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(incident_id,adapter)
);
CREATE TABLE IF NOT EXISTS runbooks (
  id uuid PRIMARY KEY, name text NOT NULL, definition jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runbook_runs (
  id uuid PRIMARY KEY, incident_id text NOT NULL REFERENCES incidents(id), definition jsonb NOT NULL,
  state text NOT NULL DEFAULT 'running', step integer NOT NULL DEFAULT 0,
  completed jsonb NOT NULL DEFAULT '[]', context jsonb NOT NULL DEFAULT '{}',
  deadline_at timestamptz NOT NULL, available_at timestamptz NOT NULL DEFAULT now(),
  error text, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runbook_due ON runbook_runs(available_at) WHERE state IN ('running','compensating');
CREATE TABLE IF NOT EXISTS auth_users (
  id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
  role text NOT NULL CHECK(role IN ('viewer','operator','admin')), disabled boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_users(id),
  expires_at timestamptz NOT NULL, csrf text NOT NULL
);
CREATE TABLE IF NOT EXISTS retention_runs (
  id uuid PRIMARY KEY, cutoff timestamptz NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
