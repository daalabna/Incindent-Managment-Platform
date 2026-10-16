-- Incident timeline lives in its own table; payload may still carry a copy during dual-write.
CREATE TABLE IF NOT EXISTS incident_timeline (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid UNIQUE NOT NULL,
  incident_id text NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at timestamptz NOT NULL,
  actor text NOT NULL,
  text text NOT NULL
);
CREATE INDEX IF NOT EXISTS incident_timeline_incident_at
  ON incident_timeline(incident_id, at DESC, sequence DESC);

-- Backfill from existing payload timelines once.
INSERT INTO incident_timeline(id, incident_id, at, actor, text)
SELECT
  COALESCE((entry->>'id')::uuid, gen_random_uuid()),
  i.id,
  COALESCE((entry->>'at')::timestamptz, i.created_at),
  COALESCE(entry->>'actor', 'system'),
  COALESCE(entry->>'text', '')
FROM incidents i
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(i.payload->'timeline', '[]'::jsonb)) AS entry
ON CONFLICT (id) DO NOTHING;
