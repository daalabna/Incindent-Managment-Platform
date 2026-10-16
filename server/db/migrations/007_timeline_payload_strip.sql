-- Timeline is authoritative in incident_timeline; stop carrying a copy in payload.
UPDATE incidents
SET payload = (payload - 'timeline') || jsonb_build_object('timeline', '[]'::jsonb)
WHERE payload ? 'timeline'
  AND jsonb_typeof(payload->'timeline') = 'array'
  AND jsonb_array_length(payload->'timeline') > 0;
