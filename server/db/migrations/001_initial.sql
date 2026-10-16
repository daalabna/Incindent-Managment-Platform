CREATE SEQUENCE IF NOT EXISTS incident_number START 1001;
CREATE TABLE IF NOT EXISTS services (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS rules (id text PRIMARY KEY, service_id text NOT NULL REFERENCES services(id), payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY,
  service_id text NOT NULL REFERENCES services(id),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('triggered','acknowledged','investigating','mitigated','resolved')),
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_correlation ON incidents(service_id, created_at DESC) WHERE status <> 'resolved';
CREATE TABLE IF NOT EXISTS audit_entries (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid UNIQUE NOT NULL,
  incident_id text REFERENCES incidents(id),
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS monitoring_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id text PRIMARY KEY,
  service_id text REFERENCES services(id),
  payload jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  incident_id text REFERENCES incidents(id),
  failure text
);
CREATE TABLE IF NOT EXISTS event_outbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text UNIQUE NOT NULL REFERENCES monitoring_events(id),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX IF NOT EXISTS event_outbox_pending ON event_outbox(sequence) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS app_metadata (key text PRIMARY KEY, value text NOT NULL);
