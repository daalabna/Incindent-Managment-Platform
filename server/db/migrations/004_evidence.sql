CREATE TABLE IF NOT EXISTS rule_matches (
  id uuid PRIMARY KEY,
  incident_id text NOT NULL REFERENCES incidents(id),
  rule_id text NOT NULL,
  service_id text NOT NULL,
  metric text NOT NULL,
  aggregation text NOT NULL,
  threshold double precision NOT NULL,
  value double precision NOT NULL,
  samples integer NOT NULL,
  window_start timestamptz,
  window_end timestamptz,
  event_ids text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rule_matches_incident ON rule_matches(incident_id, window_start);

ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS context_retained boolean NOT NULL DEFAULT true;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS reusable boolean NOT NULL DEFAULT true;
UPDATE ai_analyses SET context_retained = false, reusable = false
WHERE jsonb_exists(context->'limitations', 'Контекст удалён политикой хранения.');
DROP INDEX IF EXISTS ai_reuse;
CREATE UNIQUE INDEX ai_reuse ON ai_analyses(incident_id, context_hash, model, prompt_version)
  WHERE state IN ('queued','running','succeeded') AND reusable;
