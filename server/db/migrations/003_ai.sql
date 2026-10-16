CREATE TABLE ai_analyses (
  id uuid PRIMARY KEY,
  incident_id text NOT NULL REFERENCES incidents(id), incident_version integer NOT NULL,
  context_hash text NOT NULL, context jsonb NOT NULL,
  model text NOT NULL, prompt_version text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  deadline_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  published_at timestamptz, available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, lease_until timestamptz,
  result jsonb, error text, input_tokens integer, output_tokens integer,
  estimated_cost_usd double precision, duration_ms integer
);
CREATE UNIQUE INDEX ai_reuse ON ai_analyses(incident_id,context_hash,model,prompt_version) WHERE state <> 'failed';
CREATE INDEX ai_incident_history ON ai_analyses(incident_id,created_at DESC);
CREATE INDEX ai_due ON ai_analyses(available_at) WHERE state IN ('queued','running');
